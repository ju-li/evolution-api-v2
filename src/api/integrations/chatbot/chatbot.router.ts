import { ChatwootRouter } from '@api/integrations/chatbot/chatwoot/routes/chatwoot.router';
import { DifyRouter } from '@api/integrations/chatbot/dify/routes/dify.router';
import { OpenaiRouter } from '@api/integrations/chatbot/openai/routes/openai.router';
import { TypebotRouter } from '@api/integrations/chatbot/typebot/routes/typebot.router';
import { Chatwoot, configService, Dify, Evoai, Flowise, N8n, Openai, Typebot } from '@config/env.config';
import { Router } from 'express';

import { EvoaiRouter } from './evoai/routes/evoai.router';
import { EvolutionBotRouter } from './evolutionBot/routes/evolutionBot.router';
import { FlowiseRouter } from './flowise/routes/flowise.router';
import { N8nRouter } from './n8n/routes/n8n.router';

export class ChatbotRouter {
  public readonly router: Router;

  constructor(...guards: any[]) {
    this.router = Router();

    // EvolutionBot has no enable flag, so it is always mounted.
    this.router.use('/evolutionBot', new EvolutionBotRouter(...guards).router);

    // Only mount an integration's routes (including unauthenticated ones such as the Chatwoot webhook)
    // when the operator has enabled it, so disabled integrations add no reachable attack surface.
    if (configService.get<Chatwoot>('CHATWOOT').ENABLED) {
      this.router.use('/chatwoot', new ChatwootRouter(...guards).router);
    }
    if (configService.get<Typebot>('TYPEBOT').ENABLED) {
      this.router.use('/typebot', new TypebotRouter(...guards).router);
    }
    if (configService.get<Openai>('OPENAI').ENABLED) {
      this.router.use('/openai', new OpenaiRouter(...guards).router);
    }
    if (configService.get<Dify>('DIFY').ENABLED) {
      this.router.use('/dify', new DifyRouter(...guards).router);
    }
    if (configService.get<Flowise>('FLOWISE').ENABLED) {
      this.router.use('/flowise', new FlowiseRouter(...guards).router);
    }
    if (configService.get<N8n>('N8N').ENABLED) {
      this.router.use('/n8n', new N8nRouter(...guards).router);
    }
    if (configService.get<Evoai>('EVOAI').ENABLED) {
      this.router.use('/evoai', new EvoaiRouter(...guards).router);
    }
  }
}
