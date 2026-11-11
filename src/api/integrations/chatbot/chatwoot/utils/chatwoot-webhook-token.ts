import { Auth, configService, HttpServer } from '@config/env.config';
import { UnauthorizedException } from '@exceptions';
import { createHmac, timingSafeEqual } from 'crypto';
import { RequestHandler } from 'express';

/**
 * Per-instance secret for the Chatwoot webhook. Derived from the global API key so no
 * storage is needed: HMAC-SHA256(AUTHENTICATION_API_KEY, 'chatwoot-webhook:' + instanceName), hex.
 */
export function chatwootWebhookToken(instanceName: string): string {
  const key = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
  return createHmac('sha256', key).update(`chatwoot-webhook:${instanceName}`).digest('hex');
}

export function chatwootWebhookUrl(instanceName: string): string {
  const urlServer = configService.get<HttpServer>('SERVER').URL;
  return `${urlServer}/chatwoot/webhook/${encodeURIComponent(instanceName)}?token=${chatwootWebhookToken(instanceName)}`;
}

export function isValidChatwootWebhookToken(instanceName: string, token: unknown): boolean {
  if (typeof instanceName !== 'string' || !instanceName || typeof token !== 'string' || !token) return false;

  const expected = Buffer.from(chatwootWebhookToken(instanceName), 'utf8');
  const received = Buffer.from(token, 'utf8');

  return expected.length === received.length && timingSafeEqual(expected, received);
}

export const chatwootWebhookTokenGuard: RequestHandler = (req, _res, next) => {
  if (!isValidChatwootWebhookToken(req.params?.instanceName, req.query?.token)) {
    throw new UnauthorizedException();
  }

  return next();
};
