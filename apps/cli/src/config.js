import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function getConfigDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 't-cli');
  }
  // macOS and Linux
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 't-cli');
}

const configDir = getConfigDir();
const configPath = path.join(configDir, 'config.json');

const defaultConfig = {
  lang: 'en',
  isSimpleMode: false
};

export function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(data);
      return { ...defaultConfig, ...parsed };
    }
  } catch (error) {
    // Silently ignore read errors to prevent CLI crash
  }
  return { ...defaultConfig };
}

export function saveConfig(updates) {
  try {
    const currentConfig = loadConfig();
    const newConfig = { ...currentConfig, ...updates };
    
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');
  } catch (error) {
    // Silently ignore write errors
  }
}
