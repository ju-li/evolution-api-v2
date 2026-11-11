import { prismaRepository } from '@api/server.module';
import { configService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { IsOnWhatsapp, Prisma } from '@prisma/client';
import dayjs from 'dayjs';

const logger = new Logger('OnWhatsappCache');

function getAvailableNumbers(remoteJid: string) {
  const numbersAvailable: string[] = [];

  if (remoteJid.startsWith('+')) {
    remoteJid = remoteJid.slice(1);
  }

  const [number, domain] = remoteJid.split('@');

  // TODO: Se já for @lid, retornar apenas ele mesmo SEM adicionar @domain novamente
  if (domain === 'lid' || domain === 'g.us') {
    return [remoteJid]; // Retorna direto para @lid e @g.us
  }

  // Brazilian numbers
  if (remoteJid.startsWith('55')) {
    const numberWithDigit =
      number.slice(4, 5) === '9' && number.length === 13 ? number : `${number.slice(0, 4)}9${number.slice(4)}`;
    const numberWithoutDigit = number.length === 12 ? number : number.slice(0, 4) + number.slice(5);

    numbersAvailable.push(numberWithDigit);
    numbersAvailable.push(numberWithoutDigit);
  }

  // Mexican/Argentina numbers
  // Ref: https://faq.whatsapp.com/1294841057948784
  else if (number.startsWith('52') || number.startsWith('54')) {
    let prefix = '';
    if (number.startsWith('52')) {
      prefix = '1';
    }
    if (number.startsWith('54')) {
      prefix = '9';
    }

    const numberWithDigit =
      number.slice(2, 3) === prefix && number.length === 13
        ? number
        : `${number.slice(0, 2)}${prefix}${number.slice(2)}`;
    const numberWithoutDigit = number.length === 12 ? number : number.slice(0, 2) + number.slice(3);

    numbersAvailable.push(numberWithDigit);
    numbersAvailable.push(numberWithoutDigit);
  }

  // Other countries
  // Push the bare number: the domain is appended below, so pushing remoteJid stored and searched for
  // '<number>@s.whatsapp.net@s.whatsapp.net' (see #30).
  else {
    numbersAvailable.push(number);
  }

  return numbersAvailable.map((number) => `${number}@${domain}`);
}

interface ISaveOnWhatsappCacheParams {
  remoteJid: string;
  remoteJidAlt?: string;
  lid?: 'lid' | undefined;
}

// Entries written before #30 was fixed carry the domain twice ('<number>@s.whatsapp.net@s.whatsapp.net').
// The migration rewrites existing rows; this keeps a row clean if an old build writes one again (e.g. mid-deploy).
function repairDoubledDomain(jid: string): string {
  return jid.replace(/@s\.whatsapp\.net@s\.whatsapp\.net$/, '@s.whatsapp.net');
}

function normalizeJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  return jid.startsWith('+') ? jid.slice(1) : jid;
}

// jidOptions is a comma-joined list of JIDs. Lookups match whole entries, never substrings: a substring test finds
// '15511987654321@s.whatsapp.net' when asked for '5511987654321@s.whatsapp.net', and saveOnWhatsappCache() would then
// merge one number's JIDs into another number's row (see #32).
//
// On PostgreSQL this is `string_to_array("jidOptions", ',') && $1::text[]`, served by the GIN index
// "IsOnWhatsapp_jidOptions_elements_idx". The WHERE expression must stay exactly `string_to_array("jidOptions", ',')`,
// or the planner silently stops using the index. Prisma can't express `&&` on an expression, hence $queryRaw.
// MySQL keeps the Prisma `contains` query and drops the substring-only matches afterwards.

function isPostgres(): boolean {
  return ['postgresql', 'psql_bouncer'].includes(configService.get<Database>('DATABASE').PROVIDER);
}

/** PostgreSQL: rows whose jidOptions list any of `jids`. Keep the predicate exactly as is, see above. */
function selectByJidOptions(jids: string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT "id", "remoteJid", "jidOptions", "lid", "createdAt", "updatedAt"
    FROM "IsOnWhatsapp"
    WHERE string_to_array("jidOptions", ',') && ${jids}::text[]`;
}

function hasJidOption(record: Pick<IsOnWhatsapp, 'jidOptions'>, jids: Set<string>): boolean {
  return record.jidOptions.split(',').some((jid) => jids.has(jid));
}

/**
 * The row to merge `remoteJid` into: one listing any of `jids` (its spellings, `remoteJid` included), or stored under
 * one of them as its remoteJid. Replaces #31's two-step lookup (exact remoteJid, then a LIKE scan): the GIN index on
 * jidOptions and the unique index on remoteJid serve both branches of one query.
 */
async function findRecordToMerge(remoteJid: string, jids: string[]): Promise<IsOnWhatsapp | null> {
  const wanted = new Set(jids);
  let matches: IsOnWhatsapp[];

  if (isPostgres()) {
    // No LIMIT 1: the planner guesses hundreds of matches for `&&` and, under a LIMIT, bets on a sequential scan that
    // stops early. Without it both branches use their index (BitmapOr). A number matches a row or two.
    matches = await prismaRepository.$queryRaw<IsOnWhatsapp[]>`
      ${selectByJidOptions(jids)}
         OR "remoteJid" = ANY(${jids}::text[])
    `;
  } else {
    const candidates = await prismaRepository.isOnWhatsapp.findMany({
      where: {
        OR: [...jids.map((jid) => ({ jidOptions: { contains: jid } })), { remoteJid: { in: jids } }],
      },
    });
    matches = candidates.filter((record) => wanted.has(record.remoteJid) || hasJidOption(record, wanted));
  }

  // Prefer remoteJid's own row (updating another row to this remoteJid would violate its unique constraint), then a
  // row stored under one of its other spellings, then one that only lists it in jidOptions.
  return (
    matches.find((record) => record.remoteJid === remoteJid) ??
    matches.find((record) => wanted.has(record.remoteJid)) ??
    matches[0] ??
    null
  );
}

/** Rows listing any of `jids`, saved at or after `since`. */
async function findCachedRecords(jids: string[], since: Date): Promise<IsOnWhatsapp[]> {
  if (isPostgres()) {
    // "updatedAt" is a timestamp without time zone holding UTC (Prisma writes it so). Casting the ISO string drops
    // its 'Z' and compares UTC to UTC whatever the session time zone is.
    return prismaRepository.$queryRaw<IsOnWhatsapp[]>`
      ${selectByJidOptions(jids)}
        AND "updatedAt" >= ${since.toISOString()}::timestamp
    `;
  }

  const wanted = new Set(jids);
  const candidates = await prismaRepository.isOnWhatsapp.findMany({
    where: {
      OR: jids.map((jid) => ({ jidOptions: { contains: jid } })),
      updatedAt: { gte: since },
    },
  });
  return candidates.filter((record) => hasJidOption(record, wanted));
}

export async function saveOnWhatsappCache(data: ISaveOnWhatsappCacheParams[]) {
  if (!configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP) {
    return;
  }

  // Processa todos os itens em paralelo para melhor performance
  const processingPromises = data.map(async (item) => {
    try {
      const remoteJid = normalizeJid(item.remoteJid);
      if (!remoteJid) {
        logger.warn('[saveOnWhatsappCache] Item skipped, missing remoteJid.');
        return;
      }

      const altJidNormalized = normalizeJid(item.remoteJidAlt);
      const lidAltJid = altJidNormalized && altJidNormalized.includes('@lid') ? altJidNormalized : null;

      const baseJids = [remoteJid]; // Garante que o remoteJid esteja na lista inicial
      if (lidAltJid) {
        baseJids.push(lidAltJid);
      }

      const expandedJids = baseJids.flatMap((jid) => getAvailableNumbers(jid));

      // 1. Busca a entrada existente, numa só consulta indexada (ver findRecordToMerge e #32):
      //    pelas entradas exatas de jidOptions, ou pelo remoteJid. Inclui as variantes (9º dígito BR, MX/AR) e o
      //    LID alternativo, para achar o registro mesmo quando ele foi salvo sob a outra forma.
      //    Às vezes o remoteJid atual NÃO ESTÁ no jidOptions, o que causaria
      //    'Unique constraint failed on the fields: (`remoteJid`)' no create.
      //    Isso acontece principalmente em grupos que possuem o número do criador no ID
      //    (ex.: '559911223345-1234567890@g.us').
      // TODO: Descobrir o motivo que causa o remoteJid não estar (às vezes) incluso na lista de jidOptions
      const existingRecord = await findRecordToMerge(remoteJid, [...new Set([...expandedJids, remoteJid])]);

      logger.verbose(
        `[saveOnWhatsappCache] Register exists for [${expandedJids.join(',')}]? => ${existingRecord ? existingRecord.remoteJid : 'Not found'}`,
      );

      // 2. Unifica todos os JIDs usando um Set para garantir valores únicos
      const finalJidOptions = new Set(expandedJids);

      if (lidAltJid) {
        finalJidOptions.add(lidAltJid);
      }

      if (existingRecord?.jidOptions) {
        existingRecord.jidOptions.split(',').forEach((jid) => finalJidOptions.add(repairDoubledDomain(jid)));
      }

      // 3. Prepara o payload final
      // Ordena os JIDs para garantir consistência na string final
      const sortedJidOptions = [...finalJidOptions].sort();
      const newJidOptionsString = sortedJidOptions.join(',');
      const newLid = item.lid === 'lid' || item.remoteJid?.includes('@lid') ? 'lid' : null;

      const dataPayload = {
        remoteJid: remoteJid,
        jidOptions: newJidOptionsString,
        lid: newLid,
      };

      // 4. Decide entre Criar ou Atualizar
      if (existingRecord) {
        // Compara a string de JIDs ordenada existente com a nova
        const existingJidOptionsString = existingRecord.jidOptions
          ? existingRecord.jidOptions.split(',').sort().join(',')
          : '';

        const isDataSame =
          existingRecord.remoteJid === dataPayload.remoteJid &&
          existingJidOptionsString === dataPayload.jidOptions &&
          existingRecord.lid === dataPayload.lid;

        if (isDataSame) {
          logger.verbose(`[saveOnWhatsappCache] Data for ${remoteJid} is already up-to-date. Skipping update.`);
          return; // Pula para o próximo item
        }

        // Os dados são diferentes, então atualiza
        logger.verbose(
          `[saveOnWhatsappCache] Register exists, updating: remoteJid=${remoteJid}, jidOptions=${dataPayload.jidOptions}, lid=${dataPayload.lid}`,
        );
        await prismaRepository.isOnWhatsapp.update({
          where: { id: existingRecord.id },
          data: dataPayload,
        });
      } else {
        // Cria nova entrada
        logger.verbose(
          `[saveOnWhatsappCache] Register does not exist, creating: remoteJid=${remoteJid}, jidOptions=${dataPayload.jidOptions}, lid=${dataPayload.lid}`,
        );
        await prismaRepository.isOnWhatsapp.create({
          data: dataPayload,
        });
      }
    } catch (e) {
      // Loga o erro mas não para a execução dos outros promises
      logger.error(`[saveOnWhatsappCache] Error processing item for ${item.remoteJid}: `);
      logger.error(e);
    }
  });

  // Espera todas as operações paralelas terminarem
  await Promise.allSettled(processingPromises);
}

export async function getOnWhatsappCache(remoteJids: string[]) {
  let results: {
    remoteJid: string;
    number: string;
    jidOptions: string[];
    lid?: string;
  }[] = [];

  if (configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP) {
    const remoteJidsWithoutPlus = [...new Set(remoteJids.flatMap((remoteJid) => getAvailableNumbers(remoteJid)))];
    if (remoteJidsWithoutPlus.length === 0) {
      return results;
    }

    const onWhatsappCache = await findCachedRecords(
      remoteJidsWithoutPlus,
      dayjs().subtract(configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP_DAYS, 'days').toDate(),
    );

    results = onWhatsappCache.map((item) => ({
      remoteJid: item.remoteJid,
      number: item.remoteJid.split('@')[0],
      jidOptions: item.jidOptions.split(','),
      lid: item.lid,
    }));
  }

  return results;
}
