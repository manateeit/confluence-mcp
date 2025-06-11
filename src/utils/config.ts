import fs from 'fs';
import path from 'path';

interface ConfluenceConfig {
  baseUrl: string;
  username: string;
  apiToken: string;
}

let confluenceConfig: ConfluenceConfig | null = null;

export function loadConfig(): void {
  // Load from environment variables first
  confluenceConfig = {
    baseUrl: process.env.CONFLUENCE_BASE_URL || '',
    username: process.env.CONFLUENCE_USERNAME || '',
    apiToken: process.env.CONFLUENCE_API_TOKEN || ''
  };
  
  console.log('Confluence configuration loaded');
}

export function getConfig(): ConfluenceConfig {
  if (!confluenceConfig) {
    loadConfig();
  }
  
  if (!confluenceConfig?.baseUrl || !confluenceConfig?.username || !confluenceConfig?.apiToken) {
    throw new Error('Confluence configuration is incomplete');
  }
  
  return confluenceConfig as ConfluenceConfig;
}

export function updateConfig(config: Partial<ConfluenceConfig>): void {
  confluenceConfig = { ...getConfig(), ...config };
}