import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_FILE_NAME = "pi-cbm-settings.json";

export interface CbmSettings {
  autoIndexNonGitDirectories?: boolean;
}

const DEFAULT_SETTINGS: Required<CbmSettings> = {
  autoIndexNonGitDirectories: true,
};

function getSettingsPath(): string {
  return path.join(getAgentDir(), SETTINGS_FILE_NAME);
}

export function loadSettings(): Required<CbmSettings> {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return { ...DEFAULT_SETTINGS };

    const content = fs.readFileSync(settingsPath, "utf8");
    const settings: CbmSettings = JSON.parse(content);

    return {
      autoIndexNonGitDirectories:
        typeof settings.autoIndexNonGitDirectories === "boolean" ? settings.autoIndexNonGitDirectories : DEFAULT_SETTINGS.autoIndexNonGitDirectories,
    };
  } catch (error) {
    console.error("Failed to load pi-cbm settings:", error);
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Required<CbmSettings>): void {
  try {
    const settingsPath = getSettingsPath();
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save pi-cbm settings:", error);
  }
}
