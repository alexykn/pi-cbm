import { loadSettings, saveSettings, type CbmSettings } from "./settings.js";

export class CbmRuntimeSettings {
  private settings = loadSettings();

  get autoIndexNonGitDirectories(): boolean {
    return this.settings.autoIndexNonGitDirectories;
  }

  snapshot(): Required<CbmSettings> {
    return { ...this.settings };
  }

  reload(): void {
    this.settings = loadSettings();
  }

  setAutoIndexNonGitDirectories(value: boolean): void {
    this.settings = {
      ...this.settings,
      autoIndexNonGitDirectories: value,
    };
    saveSettings(this.settings);
  }
}
