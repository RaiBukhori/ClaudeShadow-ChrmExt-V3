(() => {
  // Hindari duplikasi listener jika script di-inject ulang
  if (window.__claudeDeepExportLoaded) return;
  window.__claudeDeepExportLoaded = true;

  // Ambil UUID chat dari URL
  function getChatId() {
    const match = window.location.pathname.match(/\/chat\/([a-f0-9-]{36})/i);
    return match ? match[1] : null;
  }

  // Ambil Organization ID dari cookie atau API internal Claude
  async function getOrgId() {
    const cookieMatch = document.cookie.match(/lastActiveOrg=([a-f0-9-]{36})/i);
    if (cookieMatch) return cookieMatch[1];

    const res = await fetch("https://claude.ai/api/organizations", {
      credentials: "include",
      headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error("Gagal mengambil Organization ID");
    const orgs = await res.json();
    return orgs?.[0]?.uuid;
  }

  // Buka otomatis semua tombol thinking & detail beranak-pinak di DOM browser
  async function forceExpandAllDOM() {
    const chatContainer = document.querySelector("main") || document.body;
    for (let pass = 0; pass < 4; pass++) {
      const collapsedButtons = chatContainer.querySelectorAll(
        'button[aria-expanded="false"], [data-state="closed"] > button, details:not([open]) > summary'
      );
      let clicked = 0;
      collapsedButtons.forEach((btn) => {
        if (
          btn.closest("nav") ||
          btn.closest("aside") ||
          btn.closest("header") ||
          btn.closest("form") ||
          btn.closest('[contenteditable="true"]') ||
          btn.hasAttribute("aria-haspopup")
        ) {
          return;
        }
        try {
          if (btn.tagName.toLowerCase() === "summary") {
            btn.parentElement.open = true;
          } else {
            btn.click();
          }
          clicked++;
        } catch (e) {}
      });
      if (clicked === 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // Ambil daftar pesan aktif secara berurutan dari pohon percakapan (tree)
  function getOrderedMessages(convData) {
    const messages = convData.chat_messages || [];
    if (!messages.length) return [];

    const msgMap = new Map();
    messages.forEach((m) => msgMap.set(m.uuid, m));

    const leafUuid = convData.current_leaf_message_uuid;
    if (leafUuid && msgMap.has(leafUuid)) {
      const branch = [];
      let curr = msgMap.get(leafUuid);
      const visited = new Set();
      while (curr && !visited.has(curr.uuid)) {
        visited.add(curr.uuid);
        branch.push(curr);
        curr = curr.parent_message_uuid ? msgMap.get(curr.parent_message_uuid) : null;
      }
      return branch.reverse();
    }

    return [...messages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }

  // Rekonstruksi dan lacak setiap versi artefak (create, update, rewrite, str_replace) agar 0% kode hilang
  class ArtifactTracker {
    constructor() {
      this.store = new Map();
    }

    processToolUse(input) {
      if (!input || typeof input !== "object") return null;
      const id = input.id || input.artifact_id || input.path;
      if (!id) return null;

      const cmd =
        input.command ||
        (input.content !== undefined || input.file_text !== undefined ? "create" : null);

      let state = this.store.get(id) || {
        id,
        title: input.title || input.description || id,
        type: input.type || "",
        language: input.language || "",
        content: "",
        version: 0
      };

      if (input.title) state.title = input.title;
      if (input.type) state.type = input.type;
      if (input.language) state.language = input.language;

      if (cmd === "create" || cmd === "rewrite") {
        state.content = input.content ?? input.file_text ?? "";
        state.version += 1;
      } else if (cmd === "update" || cmd === "str_replace" || input.old_str !== undefined) {
        if (typeof input.old_str === "string" && typeof input.new_str === "string") {
          state.content = state.content.replace(input.old_str, () => input.new_str);
        } else if (Array.isArray(input.updates)) {
          for (const u of input.updates) {
            if (typeof u.old_str === "string" && typeof u.new_str === "string") {
              state.content = state.content.replace(u.old_str, () => u.new_str);
            }
          }
        }
        state.version += 1;
      }

      this.store.set(id, { ...state });
      return this.store.get(id);
    }
  }

  // Format satu pesan (User atau Claude) persis sesuai struktur blok & kodingan
  function formatMessageFromAPI(msg, artifactTracker) {
    const roleTag = msg.sender === "human" ? "user" : "claude";
    const parts = [];

    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        const fileName = att.file_name || "attachment";
        const fileContent = att.extracted_content || "";
        parts.push(`<attachment file_name="${fileName}">\n${fileContent}\n</attachment>`);
      }
    }
    if (Array.isArray(msg.files_v2) && msg.files_v2.length > 0) {
      for (const f of msg.files_v2) {
        if (f.extracted_content) {
          parts.push(`<attachment file_name="${f.file_name || "file"}">\n${f.extracted_content}\n</attachment>`);
        }
      }
    }

    if (Array.isArray(msg.content) && msg.content.length > 0) {
      let openThinkingBlock = false;
      let thinkingBuffer = [];

      const flushThinkingBuffer = () => {
        if (openThinkingBlock) {
          parts.push(`<thinking>\n${thinkingBuffer.join("\n")}\n</thinking>`);
          openThinkingBlock = false;
          thinkingBuffer = [];
        }
      };

      for (const block of msg.content) {
        if (block.type === "thinking") {
          openThinkingBlock = true;

          if (Array.isArray(block.summaries) && block.summaries.length > 0) {
            const summaryLines = block.summaries
              .map((s) => (typeof s === "string" ? s : s.summary || JSON.stringify(s)))
              .filter(Boolean);
            if (summaryLines.length > 0) {
              thinkingBuffer.push(
                `<thinking_summaries>\n${summaryLines.map((s) => `<summary_item>${s}</summary_item>`).join("\n")}\n</thinking_summaries>`
              );
            }
          } else if (block.summary) {
            thinkingBuffer.push(`<thinking_summaries>\n<summary_item>${block.summary}</summary_item>\n</thinking_summaries>`);
          }

          if (block.thinking) {
            thinkingBuffer.push(`<thinking_detail>\n${block.thinking}\n</thinking_detail>`);
          }
        } else if (block.type === "tool_use") {
          const toolName = block.name || "tool";
          const toolId = block.id || "";
          const rawInput = typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2);

          const commandXml = [
            `<tool_use name="${toolName}"${toolId ? ` id="${toolId}"` : ""}>`,
            `<command_input>\n${rawInput}\n</command_input>`
          ];

          const isArtifactTool =
            toolName === "artifacts" ||
            toolName === "create_artifact" ||
            toolName === "update_artifact" ||
            toolName === "create_file" ||
            toolName === "str_replace" ||
            toolName === "str_replace_editor" ||
            (block.input && (block.input.id || block.input.artifact_id) && block.input.command);

          if (isArtifactTool) {
            const artState = artifactTracker.processToolUse(block.input);
            if (artState && artState.content) {
              commandXml.push(
                `<antArtifact identifier="${artState.id}" type="${artState.type}" language="${artState.language}" title="${artState.title}" version="${artState.version}">\n${artState.content}\n</antArtifact>`
              );
            }
          }

          commandXml.push(`</tool_use>`);

          if (openThinkingBlock) {
            thinkingBuffer.push(commandXml.join("\n"));
          } else {
            parts.push(commandXml.join("\n"));
          }
        } else if (block.type === "tool_result") {
          const toolName = block.name || "tool";
          const toolUseId = block.tool_use_id || "";
          let resultContent = "";
          if (typeof block.content === "string") {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            resultContent = block.content
              .map((c) => (typeof c === "string" ? c : c.text || JSON.stringify(c, null, 2)))
              .join("\n");
          } else if (block.content) {
            resultContent = JSON.stringify(block.content, null, 2);
          }

          const resultXml = `<tool_result name="${toolName}"${toolUseId ? ` tool_use_id="${toolUseId}"` : ""}${block.is_error ? ` is_error="true"` : ""}>\n${resultContent}\n</tool_result>`;

          if (openThinkingBlock) {
            thinkingBuffer.push(resultXml);
          } else {
            parts.push(resultXml);
          }
        } else if (block.type === "text") {
          flushThinkingBuffer();
          if (block.text) {
            parts.push(block.text);
          }
        } else {
          const fallbackXml = `<content_block type="${block.type || "unknown"}">\n${JSON.stringify(block, null, 2)}\n</content_block>`;
          if (openThinkingBlock) {
            thinkingBuffer.push(fallbackXml);
          } else {
            parts.push(fallbackXml);
          }
        }
      }

      flushThinkingBuffer();
    } else if (msg.text) {
      parts.push(msg.text);
    }

    return `<${roleTag}>\n${parts.join("\n")}\n</${roleTag}>`;
  }

  // Fallback & Suplemen: Ekstrak struktur hierarki langsung dari DOM Browser
  function extractFromDOMHierarchy() {
    const main = document.querySelector("main") || document.body;
    const turnBlocks = main.querySelectorAll('[data-testid="user-message"], .font-claude-message, [data-test-render-count]');

    function serializeNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";

      const tag = node.tagName.toLowerCase();
      if (tag === "svg" || tag === "path" || tag === "script" || tag === "style") return "";

      const childrenText = Array.from(node.childNodes).map(serializeNode).join("");

      if (tag === "button" && node.hasAttribute("aria-expanded") && !node.hasAttribute("aria-haspopup")) {
        return `\n<thinking_summary_header>${childrenText.trim()}</thinking_summary_header>\n`;
      }
      if (tag === "pre") {
        const codeEl = node.querySelector("code");
        const langMatch = codeEl?.className?.match(/language-([\w-]+)/);
        const lang = langMatch ? langMatch[1] : "";
        return `\n\`\`\`${lang}\n${codeEl ? codeEl.textContent : node.textContent}\n\`\`\`\n`;
      }
      if (tag === "div" || tag === "p" || tag === "section" || tag === "li") {
        return `${childrenText}\n`;
      }
      return childrenText;
    }

    if (!turnBlocks.length) {
      return serializeNode(main).trim();
    }

    const out = [];
    turnBlocks.forEach((el) => {
      const isUser = el.getAttribute("data-testid") === "user-message" || el.querySelector('[data-testid="user-message"]');
      const role = isUser ? "user" : "claude";
      out.push(`<${role}>\n${serializeNode(el).trim()}\n</${role}>`);
    });
    return out.join("\n\n");
  }

  async function extractFullClaudeHistory(options = { expandDomFirst: true }) {
    if (options.expandDomFirst) {
      await forceExpandAllDOM();
    }

    const chatId = getChatId();
    if (!chatId) {
      throw new Error("Buka halaman percakapan Claude terlebih dahulu (https://claude.ai/chat/...)");
    }

    const orgId = await getOrgId();
    const apiUrl = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${chatId}?tree=True&rendering_mode=messages&render_all_tools=true`;

    const response = await fetch(apiUrl, {
      credentials: "include",
      headers: { "Accept": "application/json" }
    });

    if (!response.ok) {
      return extractFromDOMHierarchy();
    }

    const convData = await response.json();
    const orderedMessages = getOrderedMessages(convData);
    const artifactTracker = new ArtifactTracker();

    const formattedMessages = orderedMessages.map((msg) => formatMessageFromAPI(msg, artifactTracker));
    return formattedMessages.join("\n\n");
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "EXTRACT_CLAUDE_CHAT") {
      extractFullClaudeHistory({ expandDomFirst: true })
        .then((fullText) => {
          sendResponse({ success: true, data: fullText });
        })
        .catch((err) => {
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }
  });
})();