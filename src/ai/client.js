import Anthropic from '@anthropic-ai/sdk';
import config from '../config.js';

const anthropic = new Anthropic({
    apiKey: config.anthropicApiKey,
});

export default anthropic;
