import { App, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { segmentText } from "../src/segmentation/segment.js";
import { OpenAICompatibleClient, DailyTokenLimitError } from "../src/extraction/llm-client.js";
import { classifySegmentsBatched } from "../src/extraction/classify.js";
import { RateLimitedClient } from "../src/extraction/rate-limited-client.js";
import {
  derivePrecedesEdges,
  detectRevisionCandidates,
} from "../src/extraction/relations-rule-based.js";
import { extractRelationsBatched } from "../src/extraction/extract-relations.js";
import { assembleSemanticIR } from "../src/pipeline/assemble.js";
import type { HttpTransport } from "../src/extraction/transport.js";

// Plugin guidelines require requestUrl over fetch: it bypasses the renderer's
// CORS checks, so any OpenAI-compatible endpoint works.
const obsidianTransport: HttpTransport = async (url, init) => {
  const response = await requestUrl({
    url,
    method: init.method,
    headers: init.headers,
    body: init.body,
    throw: false,
  });
  const headerValue = (name: string): string | null => {
    const lower = name.toLowerCase();
    for (const key of Object.keys(response.headers)) {
      if (key.toLowerCase() === lower) return response.headers[key];
    }
    return null;
  };
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: { get: headerValue },
    text: () => Promise.resolve(response.text),
    json: () => Promise.resolve(JSON.parse(response.text) as unknown),
  };
};

interface SemanticIRSettings {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  tpmLimit: number;
}

const DEFAULT_SETTINGS: SemanticIRSettings = {
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "",
  // Client-side throttle only — not the provider's actual limit.
  // Conservative default that works on most free tiers; raise it if your
  // provider allows more and you want faster processing.
  tpmLimit: 8000,
};

export default class SemanticIRPlugin extends Plugin {
  settings: SemanticIRSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "compile-current-note",
      name: "Compile current note",
      callback: () => this.compileCurrentNote(),
    });

    this.addSettingTab(new SemanticIRSettingTab(this.app, this));
  }

  async loadSettings() {
    const stored = (await this.loadData()) as Partial<SemanticIRSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...stored };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async compileCurrentNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file open.");
      return;
    }

    const missing: string[] = [];
    if (!this.settings.llmBaseUrl) missing.push("LLM base URL");
    if (!this.settings.llmApiKey) missing.push("LLM API key");
    if (!this.settings.llmModel) missing.push("LLM model");
    if (missing.length > 0) {
      new Notice(`Missing settings: ${missing.join(", ")}`);
      return;
    }

    try {
      const inputText = await this.app.vault.read(file);
      const documentId = file.path;

      const client = new OpenAICompatibleClient({
        baseUrl: this.settings.llmBaseUrl,
        apiKey: this.settings.llmApiKey,
        model: this.settings.llmModel,
        transport: obsidianTransport,
      });
      const rateLimitedClient = new RateLimitedClient(client, {
        tpmLimit: this.settings.tpmLimit,
        reservedCompletionTokens: 3000,
      });

      // Relation extraction needs a higher maxTokens — the reasoning model
      // spent all 4096 tokens reasoning about relations and produced zero
      // content.  8192/6000 are a first attempt, not yet empirically verified;
      // the next run's finish_reason/usage data should confirm or revise.
      const relationClient = new OpenAICompatibleClient({
        baseUrl: this.settings.llmBaseUrl,
        apiKey: this.settings.llmApiKey,
        model: this.settings.llmModel,
        transport: obsidianTransport,
        maxTokens: 8192,
      });
      const relationRateLimitedClient = new RateLimitedClient(relationClient, {
        tpmLimit: this.settings.tpmLimit,
        // A single relation-extraction call's reserved cost (~1500 input for a
        // 10-node batch + 6000 reserved ≈ 7500) fits within the 8K TPM budget,
        // but only barely — the proactive limiter can fit one call per window.
        reservedCompletionTokens: 6000,
      });

      // 1. Segment
      const segments = segmentText(inputText);

      // 2. Classify
      const nodes = await classifySegmentsBatched(segments, documentId, rateLimitedClient, 10);

      // 3. Rule-based relations
      const precedesEdges = derivePrecedesEdges(nodes);
      const revisionCandidates = detectRevisionCandidates(nodes);

      // 4. LLM relations
      const llmEdges = await extractRelationsBatched(
        nodes,
        revisionCandidates,
        inputText,
        relationRateLimitedClient,
        10
      );

      // 5. Assemble
      const ir = assembleSemanticIR(
        nodes,
        precedesEdges,
        llmEdges,
        documentId,
        inputText
      );

      // Write IR as a fenced JSON note
      const baseName = file.basename;
      const irFileName = `${baseName}.ir.json.md`;
      const irContent = "```json\n" + JSON.stringify(ir, null, 2) + "\n```";

      const existingFile = this.app.vault.getAbstractFileByPath(
        `${file.parent?.path ?? ""}/${irFileName}`
      );
      const irPath = existingFile
        ? `${file.parent?.path ?? ""}/${irFileName}`
        : `${file.parent?.path ?? ""}/${irFileName}`;

      const irFile = await this.app.vault.create(irPath, irContent);
      await this.app.workspace.openLinkText(irFile.path, "", true);

      new Notice(
        `Lattice: ${ir.nodes.length} nodes, ${ir.edges.length} edges`
      );
    } catch (err) {
      console.error("[Lattice] Pipeline error:", err);
      if (err instanceof DailyTokenLimitError) {
        new Notice(
          "Daily token quota reached for your API provider. The run stopped cleanly — no partial output was written. Try again after your quota resets, or use an API plan with a higher daily limit."
        );
        return;
      }
      const msg =
        err instanceof Error ? err.message : String(err);
      const truncated =
        msg.length > 500 ? msg.slice(0, 500) + "..." : msg;
      new Notice(`Pipeline error: ${truncated}`);
    }
  }
}

const SETTING_STRINGS = {
  baseUrl: {
    name: "LLM base URL",
    desc: "Base URL of an OpenAI-compatible API endpoint.",
    placeholder: "https://api.openai.com/v1",
  },
  apiKey: {
    name: "LLM API key",
    desc: "Your API key. Stored locally in the vault.",
    placeholder: "sk-...",
  },
  model: {
    name: "LLM model",
    desc: "Model identifier as given by your provider.",
    placeholder: "gpt-4o-mini",
  },
  tpmLimit: {
    name: "Rate limit (TPM)",
    desc: "Maximum estimated tokens per minute the plugin will send. This is only a client-side throttle, not your provider's actual limit.",
    placeholder: "8000",
  },
} as const;

class SemanticIRSettingTab extends PluginSettingTab {
  plugin: SemanticIRPlugin;

  constructor(app: App, plugin: SemanticIRPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Declared settings for Obsidian 1.13+ (searchable settings home).
  // Older versions ignore this and fall back to display() below. Callback
  // params are annotated explicitly so this file stays free of `any` even
  // when the types resolve against an older obsidian (e.g. the root's 1.8.7
  // peer pin, which predates this API).
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: SETTING_STRINGS.baseUrl.name,
        desc: SETTING_STRINGS.baseUrl.desc,
        control: {
          type: "text",
          key: "llmBaseUrl",
          placeholder: SETTING_STRINGS.baseUrl.placeholder,
        },
      },
      {
        name: SETTING_STRINGS.apiKey.name,
        desc: SETTING_STRINGS.apiKey.desc,
        // The declarative text control can't mask the input, so the key row
        // is rendered imperatively with a password field.
        render: (setting: Setting) => this.addApiKeyControl(setting),
      },
      {
        name: SETTING_STRINGS.model.name,
        desc: SETTING_STRINGS.model.desc,
        control: {
          type: "text",
          key: "llmModel",
          placeholder: SETTING_STRINGS.model.placeholder,
        },
      },
      {
        name: SETTING_STRINGS.tpmLimit.name,
        desc: SETTING_STRINGS.tpmLimit.desc,
        control: {
          type: "number",
          key: "tpmLimit",
          placeholder: SETTING_STRINGS.tpmLimit.placeholder,
          defaultValue: DEFAULT_SETTINGS.tpmLimit,
          min: 1,
          step: 100,
          validate: (value: number) =>
            Number.isFinite(value) && value > 0 ? undefined : "Enter a positive number.",
        },
      },
    ];
  }

  private addApiKeyControl(setting: Setting): void {
    setting.addText((text) => {
      text.inputEl.type = "password";
      text
        .setPlaceholder(SETTING_STRINGS.apiKey.placeholder)
        .setValue(this.plugin.settings.llmApiKey)
        .onChange(async (value) => {
          this.plugin.settings.llmApiKey = value;
          await this.plugin.saveSettings();
        });
    });
  }

  // Fallback for Obsidian < 1.13, which has no getSettingDefinitions().
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(SETTING_STRINGS.baseUrl.name)
      .setDesc(SETTING_STRINGS.baseUrl.desc)
      .addText((text) =>
        text
          .setPlaceholder(SETTING_STRINGS.baseUrl.placeholder)
          .setValue(this.plugin.settings.llmBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.llmBaseUrl = value;
            await this.plugin.saveSettings();
          })
      );

    this.addApiKeyControl(
      new Setting(containerEl)
        .setName(SETTING_STRINGS.apiKey.name)
        .setDesc(SETTING_STRINGS.apiKey.desc)
    );

    new Setting(containerEl)
      .setName(SETTING_STRINGS.model.name)
      .setDesc(SETTING_STRINGS.model.desc)
      .addText((text) =>
        text
          .setPlaceholder(SETTING_STRINGS.model.placeholder)
          .setValue(this.plugin.settings.llmModel)
          .onChange(async (value) => {
            this.plugin.settings.llmModel = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(SETTING_STRINGS.tpmLimit.name)
      .setDesc(SETTING_STRINGS.tpmLimit.desc)
      .addText((text) =>
        text
          .setPlaceholder(SETTING_STRINGS.tpmLimit.placeholder)
          .setValue(String(this.plugin.settings.tpmLimit))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              this.plugin.settings.tpmLimit = parsed;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
