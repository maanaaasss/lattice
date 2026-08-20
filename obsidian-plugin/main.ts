import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { segmentText } from "../src/segmentation/segment.js";
import { OpenAICompatibleClient } from "../src/extraction/llm-client.js";
import { classifySegmentsBatched } from "../src/extraction/classify.js";
import { RateLimitedClient } from "../src/extraction/rate-limited-client.js";
import {
  derivePrecedesEdges,
  detectRevisionCandidates,
} from "../src/extraction/relations-rule-based.js";
import { extractRelationsBatched } from "../src/extraction/extract-relations.js";
import { assembleSemanticIR } from "../src/pipeline/assemble.js";

interface SemanticIRSettings {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

const DEFAULT_SETTINGS: SemanticIRSettings = {
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "",
};

export default class SemanticIRPlugin extends Plugin {
  settings: SemanticIRSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "compile-current-note",
      name: "Compile current note into Semantic IR",
      callback: () => this.compileCurrentNote(),
    });

    this.addSettingTab(new SemanticIRSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
    if (!this.settings.llmBaseUrl) missing.push("LLM Base URL");
    if (!this.settings.llmApiKey) missing.push("LLM API Key");
    if (!this.settings.llmModel) missing.push("LLM Model");
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
      });
      const rateLimitedClient = new RateLimitedClient(client, {
        tpmLimit: 6000,
        maxTokensPerCall: 2048,
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
        rateLimitedClient,
        20
      );

      // 5. Assemble
      const ir = assembleSemanticIR(
        nodes,
        precedesEdges,
        llmEdges,
        documentId
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
        `Semantic IR compiled: ${ir.nodes.length} nodes, ${ir.edges.length} edges`
      );
    } catch (err) {
      console.error("[SemanticIR] Pipeline error:", err);
      const msg =
        err instanceof Error ? err.message : String(err);
      const truncated =
        msg.length > 500 ? msg.slice(0, 500) + "..." : msg;
      new Notice(`Pipeline error: ${truncated}`);
    }
  }
}

class SemanticIRSettingTab extends PluginSettingTab {
  plugin: SemanticIRPlugin;

  constructor(app: App, plugin: SemanticIRPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Semantic IR Compiler" });

    new Setting(containerEl)
      .setName("LLM Base URL")
      .setDesc("e.g. https://api.openai.com/v1")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.llmBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.llmBaseUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("LLM API Key")
      .setDesc("Your API key (stored locally in the vault)")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.llmApiKey)
          .onChange(async (value) => {
            this.plugin.settings.llmApiKey = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("LLM Model")
      .setDesc("Model identifier, e.g. gpt-4o-mini")
      .addText((text) =>
        text
          .setPlaceholder("gpt-4o-mini")
          .setValue(this.plugin.settings.llmModel)
          .onChange(async (value) => {
            this.plugin.settings.llmModel = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
