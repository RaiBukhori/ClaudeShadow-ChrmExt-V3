document.addEventListener("DOMContentLoaded", async () => {
  const copyBtn = document.getElementById("copyBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const saveCurrentBtn = document.getElementById("saveCurrentBtn");
  const accountGrid = document.getElementById("accountGrid");
  const accTitleCount = document.getElementById("accTitleCount");
  const exportDataBtn = document.getElementById("exportDataBtn");
  const importDataBtn = document.getElementById("importDataBtn");
  const importFileInput = document.getElementById("importFileInput");
  const importFileLabel = document.getElementById("importFileLabel");
  const copyBackupBtn = document.getElementById("copyBackupBtn");
  const pasteImportBtn = document.getElementById("pasteImportBtn");
  const pastePanel = document.getElementById("pastePanel");
  const pasteArea = document.getElementById("pasteArea");
  const pasteCancelBtn = document.getElementById("pasteCancelBtn");
  const pasteConfirmBtn = document.getElementById("pasteConfirmBtn");
  const statusMsg = document.getElementById("statusMsg");

  // Mode tab penuh (dibuka dari tombol "Impor File"): file picker stabil karena halaman tidak tertutup
  const isFullTabView = new URLSearchParams(location.search).get("view") === "tab";
  if (isFullTabView) document.body.classList.add("is-tab");

  // Elemen Inline Modal (pengganti window.prompt & window.confirm untuk Android & Desktop)
  const inlineModal = document.getElementById("inlineModal");
  const modalLabel = document.getElementById("modalLabel");
  const modalInput = document.getElementById("modalInput");
  const modalCancelBtn = document.getElementById("modalCancelBtn");
  const modalConfirmBtn = document.getElementById("modalConfirmBtn");

  let statusTimer = null;
  function setStatus(text, duration = 4500) {
    if (statusTimer) clearTimeout(statusTimer);
    statusMsg.textContent = text;
    if (duration > 0) {
      statusTimer = setTimeout(() => {
        if (statusMsg.textContent === text) statusMsg.textContent = "";
      }, duration);
    }
  }

  // =========================================================================
  // 0. UNIVERSAL DIALOG & TAB DETECTOR (ANDROID TITANIUM + DESKTOP CHROME)
  // =========================================================================
  let activeModalResolver = null;

  function closeInlineModal(result) {
    inlineModal.classList.remove("show");
    if (activeModalResolver) {
      const resolve = activeModalResolver;
      activeModalResolver = null;
      resolve(result);
    }
  }

  function askInlinePrompt(labelText, defaultValue = "") {
    if (activeModalResolver) closeInlineModal(null);
    return new Promise((resolve) => {
      activeModalResolver = resolve;
      modalLabel.textContent = labelText;
      modalInput.style.display = "block";
      modalInput.value = defaultValue;
      modalConfirmBtn.textContent = "Simpan";
      modalCancelBtn.textContent = "Batal";
      inlineModal.classList.add("show");
      setTimeout(() => {
        modalInput.focus();
        modalInput.select();
      }, 30);
    });
  }

  function askInlineConfirm(labelText, confirmText = "Ya", cancelText = "Tidak") {
    if (activeModalResolver) closeInlineModal(false);
    return new Promise((resolve) => {
      activeModalResolver = resolve;
      modalLabel.textContent = labelText;
      modalInput.style.display = "none";
      modalConfirmBtn.textContent = confirmText;
      modalCancelBtn.textContent = cancelText;
      inlineModal.classList.add("show");
    });
  }

  modalConfirmBtn.addEventListener("click", () => {
    if (modalInput.style.display === "none") {
      closeInlineModal(true);
    } else {
      closeInlineModal(modalInput.value);
    }
  });

  modalCancelBtn.addEventListener("click", () => {
    if (modalInput.style.display === "none") {
      closeInlineModal(false);
    } else {
      closeInlineModal(null);
    }
  });

  modalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      closeInlineModal(modalInput.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeInlineModal(null);
    }
  });

  // Di Android (Titanium/Kiwi), popup kadang terbuka sebagai tab aktif sendiri.
  // Fungsi ini mencari tab claude.ai yang sesungguhnya di seluruh window/tab.
  async function findClaudeTab() {
    try {
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = activeTabs?.[0];
      if (activeTab && activeTab.url && activeTab.url.includes("claude.ai")) {
        return activeTab;
      }

      const allTabs = await chrome.tabs.query({});
      const claudeTabs = allTabs.filter((t) => t.url && t.url.includes("claude.ai"));
      if (claudeTabs.length > 0) {
        // Utamakan yang active atau yang paling terakhir dibuka
        return claudeTabs.find((t) => t.active) || claudeTabs[claudeTabs.length - 1];
      }

      // Jika belum ada tab claude.ai tapi ada tab web biasa (bukan halaman ekstensi)
      if (activeTab && activeTab.url && !activeTab.url.startsWith("chrome-extension://")) {
        return activeTab;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // Navigasi atau reload tab claude.ai yang aman di Android & Desktop
  async function navigateOrOpenClaude(targetUrl, forceReloadOnly = false) {
    const claudeTab = await findClaudeTab();
    const isClaudeUrl = claudeTab && claudeTab.url && claudeTab.url.includes("claude.ai");

    if (isClaudeUrl) {
      if (forceReloadOnly) {
        await chrome.tabs.reload(claudeTab.id);
      } else {
        await chrome.tabs.update(claudeTab.id, { url: targetUrl, active: true });
      }
      return;
    }

    await chrome.tabs.create({ url: targetUrl, active: true });
  }

  // Copy teks universal (Clipboard API + Fallback execCommand untuk Android WebView)
  async function copyTextUniversal(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (!ok) throw new Error("Gagal menyalin ke clipboard");
      return true;
    }
  }

  // =========================================================================
  // 1. LOGIKA DEEP EXPORTER (COPY & DOWNLOAD TXT)
  // =========================================================================
  async function sendExtractMessage(tabId) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { action: "EXTRACT_CLAUDE_CHAT" }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  async function runExtraction(mode) {
    setStatus("Membuka seluruh nested thinking & mengambil data...", 0);
    copyBtn.disabled = true;
    downloadBtn.disabled = true;

    try {
      const tab = await findClaudeTab();
      if (!tab || !tab.url || !tab.url.includes("claude.ai")) {
        setStatus("Error: Buka tab percakapan claude.ai terlebih dahulu.");
        return;
      }

      let response;
      try {
        response = await sendExtractMessage(tab.id);
      } catch (err) {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["content.css"]
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"]
        });
        response = await sendExtractMessage(tab.id);
      }

      if (!response || !response.success) {
        setStatus("Gagal: " + (response?.error || "Unknown error"));
        return;
      }

      const rawText = response.data || "";

      if (mode === "copy") {
        await copyTextUniversal(rawText);
        setStatus(`Berhasil dicopy! (${rawText.length.toLocaleString()} karakter, 0% hilang)`);
      } else if (mode === "download") {
        const blob = new Blob([rawText], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `claude-history-${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        setStatus(`Berhasil didownload! (${rawText.length.toLocaleString()} karakter)`);
      }
    } catch (err) {
      setStatus("Error: " + err.message);
    } finally {
      copyBtn.disabled = false;
      downloadBtn.disabled = false;
    }
  }

  copyBtn.addEventListener("click", () => runExtraction("copy"));
  downloadBtn.addEventListener("click", () => runExtraction("download"));

  // =========================================================================
  // 2. HELPER COOKIES CLAUDE.AI (UNIVERSAL ANDROID & DESKTOP)
  // =========================================================================
  async function getActiveStoreIds() {
    const storeIds = new Set();
    try {
      const tab = await findClaudeTab();
      if (tab && tab.cookieStoreId) storeIds.add(tab.cookieStoreId);
    } catch (e) {}

    try {
      if (chrome.cookies && chrome.cookies.getAllCookieStores) {
        const stores = await chrome.cookies.getAllCookieStores();
        stores.forEach((s) => {
          if (s.id) storeIds.add(s.id);
        });
      }
    } catch (e) {}

    return Array.from(storeIds);
  }

  async function getClaudeCookies() {
    const cookieMap = new Map();
    const addCookies = (list) => {
      if (!Array.isArray(list)) return;
      for (const c of list) {
        if (c && c.name && (!c.domain || c.domain.includes("claude.ai"))) {
          const key = `${c.name}|${c.domain || "claude.ai"}|${c.path || "/"}`;
          cookieMap.set(key, c);
        }
      }
    };

    // 1. Coba query langsung dengan URL dan Domain (paling akurat di Android & Desktop MV3)
    const queries = [
      { url: "https://claude.ai/" },
      { domain: "claude.ai" },
      { domain: ".claude.ai" },
      {}
    ];

    for (const q of queries) {
      try {
        const res = await chrome.cookies.getAll(q);
        addCookies(res);
      } catch (e) {}
    }

    // 2. Jika masih kosong di Android Titanium (karena perbedaan cookieStoreId), cek semua storeId
    if (cookieMap.size === 0) {
      const storeIds = await getActiveStoreIds();
      for (const storeId of storeIds) {
        for (const q of [{ url: "https://claude.ai/", storeId }, { domain: "claude.ai", storeId }]) {
          try {
            const res = await chrome.cookies.getAll(q);
            addCookies(res);
          } catch (e) {}
        }
      }
    }

    // 3. Fallback tambahan: baca document.cookie dari tab claude.ai jika API cookie dibatasi browser
    if (cookieMap.size === 0) {
      const tab = await findClaudeTab();
      if (tab && tab.url && tab.url.includes("claude.ai")) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.cookie
          });
          const rawCookieStr = results?.[0]?.result || "";
          if (rawCookieStr) {
            rawCookieStr.split(";").forEach((pair) => {
              const idx = pair.indexOf("=");
              if (idx > 0) {
                const name = pair.slice(0, idx).trim();
                const value = pair.slice(idx + 1).trim();
                if (name) {
                  cookieMap.set(`${name}|.claude.ai|/`, {
                    name,
                    value,
                    domain: ".claude.ai",
                    path: "/",
                    secure: true,
                    httpOnly: false
                  });
                }
              }
            });
          }
        } catch (e) {}
      }
    }

    return Array.from(cookieMap.values());
  }

  function getSessionSignature(cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) return null;
    const sessionCookie = cookies.find((c) => c.name === "sessionKey");
    if (sessionCookie?.value) return `sk:${sessionCookie.value}`;

    const orgCookie = cookies.find((c) => c.name === "lastActiveOrg");
    const userCookie = cookies.find((c) => c.name === "ajs_user_id" || c.name === "intercom-session");
    if (orgCookie?.value || userCookie?.value) {
      return `org:${orgCookie?.value || ""}_usr:${userCookie?.value || ""}`;
    }

    return null;
  }

  async function clearClaudeCookies() {
    const cookies = await getClaudeCookies();
    const storeIds = await getActiveStoreIds();

    for (const c of cookies) {
      const rawDomain = c.domain || "claude.ai";
      const cleanDomain = rawDomain.startsWith(".") ? rawDomain.slice(1) : rawDomain;
      const path = c.path || "/";
      const urls = [
        `https://${cleanDomain}${path}`,
        `https://claude.ai${path}`,
        `http://${cleanDomain}${path}`
      ];

      for (const url of urls) {
        try {
          await chrome.cookies.remove({ url, name: c.name });
        } catch (e) {}

        for (const storeId of storeIds) {
          try {
            await chrome.cookies.remove({ url, name: c.name, storeId });
          } catch (e) {}
        }
      }
    }

    // Bersihkan juga cookie non-HttpOnly via script di tab jika tab claude.ai sedang terbuka
    const tab = await findClaudeTab();
    if (tab && tab.url && tab.url.includes("claude.ai")) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            document.cookie.split(";").forEach((c) => {
              const name = c.split("=")[0].trim();
              if (name) {
                document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.claude.ai`;
                document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
              }
            });
          }
        });
      } catch (e) {}
    }
  }

  async function restoreClaudeCookies(savedCookies) {
    await clearClaudeCookies();
    if (!Array.isArray(savedCookies)) return;

    const tab = await findClaudeTab();
    const targetStoreId = tab?.cookieStoreId || null;

    for (const c of savedCookies) {
      if (!c || !c.name) continue;
      const rawDomain = c.domain || ".claude.ai";
      const cleanDomain = rawDomain.startsWith(".") ? rawDomain.slice(1) : rawDomain;
      const isHostPrefix = c.name.startsWith("__Host-");
      const isSecurePrefix = c.name.startsWith("__Secure-") || isHostPrefix;
      const secureFlag = isSecurePrefix ? true : (c.secure ?? true);
      const path = isHostPrefix ? "/" : (c.path || "/");
      const url = `http${secureFlag ? "s" : ""}://${cleanDomain}${path}`;

      const baseDetails = {
        url,
        name: c.name,
        value: c.value ?? "",
        path,
        secure: secureFlag,
        httpOnly: Boolean(c.httpOnly)
      };

      if (!c.hostOnly && !isHostPrefix && c.domain) {
        baseDetails.domain = c.domain;
      }

      if (!c.session && c.expirationDate && c.expirationDate > Date.now() / 1000) {
        baseDetails.expirationDate = c.expirationDate;
      } else {
        // Beri masa aktif default 30 hari jika cookie tidak memiliki expirationDate
        baseDetails.expirationDate = Math.floor(Date.now() / 1000) + 30 * 86400;
      }

      const validSameSite = ["lax", "strict", "no_restriction"];
      if (c.sameSite && validSameSite.includes(c.sameSite.toLowerCase())) {
        baseDetails.sameSite = c.sameSite.toLowerCase();
        if (baseDetails.sameSite === "no_restriction") {
          baseDetails.secure = true;
        }
      }

      // Coba set cookie dengan konfigurasi lengkap, jika ditolak browser Android, fallback bertahap
      let success = false;
      const attempts = [
        targetStoreId ? { ...baseDetails, storeId: targetStoreId } : baseDetails,
        baseDetails,
        {
          url: "https://claude.ai/",
          name: c.name,
          value: c.value ?? "",
          path: "/",
          secure: true
        }
      ];

      for (const attempt of attempts) {
        try {
          const res = await chrome.cookies.set(attempt);
          if (res) {
            success = true;
            break;
          }
        } catch (e) {}
      }

      // Jika cookie bukan HttpOnly dan gagal disetel via API, tulis juga lewat document.cookie
      if (!success && !c.httpOnly && tab && tab.url && tab.url.includes("claude.ai")) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (name, val) => {
              document.cookie = `${name}=${val};path=/;domain=.claude.ai;SameSite=Lax;Secure`;
            },
            args: [c.name, c.value ?? ""]
          });
        } catch (e) {}
      }
    }
  }

  // =========================================================================
  // 3. MANAJEMEN AKUN (GRID KOTAK-KOTAK KECIL)
  // =========================================================================
  async function getStorageData() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get({ accounts: [], activeAccountId: null }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve({
          accounts: Array.isArray(res?.accounts) ? res.accounts : [],
          activeAccountId: res?.activeAccountId ?? null
        });
      });
    });
  }

  async function saveStorageData(accounts, activeAccountId) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ accounts, activeAccountId }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  // ---- Identitas akun (supaya login ulang = akun yang sama, walau sessionKey berubah) ----
  const hasSessionKey = (cookies) =>
    Array.isArray(cookies) && cookies.some((c) => c && c.name === "sessionKey" && c.value);

  // Ambil identitas akun yang sedang login langsung dari claude.ai (lewat tab claude.ai)
  // status: "ok" | "loggedout" | "unknown"
  async function fetchCurrentIdentity() {
    try {
      const tab = await findClaudeTab();
      if (!tab || !tab.url || !tab.url.includes("claude.ai")) return { status: "unknown" };
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          try {
            const r = await fetch("https://claude.ai/api/account", {
              credentials: "include",
              headers: { Accept: "application/json" }
            });
            if (r.status === 401 || r.status === 403) return { status: "loggedout" };
            if (!r.ok) return { status: "unknown" };
            const j = await r.json();
            const uuid = j?.uuid || j?.account?.uuid || null;
            const email = j?.email_address || j?.email || j?.account?.email_address || null;
            if (!uuid && !email) return { status: "unknown" };
            return { status: "ok", uuid, email };
          } catch (e) {
            return { status: "unknown" };
          }
        }
      });
      return results?.[0]?.result || { status: "unknown" };
    } catch (e) {
      return { status: "unknown" };
    }
  }

  const accHasIdentity = (acc) => Boolean(acc && (acc.identityUuid || acc.identityEmail));

  function identityMatches(acc, ident) {
    if (!acc || !ident) return false;
    if (ident.uuid && acc.identityUuid && ident.uuid === acc.identityUuid) return true;
    if (ident.email && acc.identityEmail && ident.email.toLowerCase() === acc.identityEmail.toLowerCase()) return true;
    return false;
  }

  function applyIdentity(acc, ident) {
    if (ident && ident.status === "ok") {
      if (ident.uuid) acc.identityUuid = ident.uuid;
      if (ident.email) acc.identityEmail = ident.email;
    }
  }

  const cookieValue = (cookies, name) => (cookies || []).find((c) => c && c.name === name)?.value || "";

  // Cari akun tersimpan yang cocok dengan sesi saat ini. Return index atau -1.
  function findAccountIndex(accounts, ident, cookies) {
    const identOk = ident && ident.status === "ok";

    // 1. Identitas dari API (paling akurat)
    if (identOk) {
      const i = accounts.findIndex((a) => identityMatches(a, ident));
      if (i !== -1) return i;
    }

    // Akun yang identitasnya terbukti berbeda tidak boleh dicocokkan lewat cara lemah di bawah
    const candidates = accounts
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => !(identOk && accHasIdentity(a)));

    // 2. Signature sessionKey sama
    const sig = getSessionSignature(cookies);
    if (sig) {
      const hit = candidates.find(({ a }) => getSessionSignature(a.cookies || []) === sig);
      if (hit) return hit.i;
    }

    // 3. ajs_user_id sama (akun lama yang belum punya identitas)
    const uid = cookieValue(cookies, "ajs_user_id");
    if (uid) {
      const hit = candidates.find(({ a }) => cookieValue(a.cookies, "ajs_user_id") === uid);
      if (hit) return hit.i;
    }

    // 4. lastActiveOrg sama, hanya jika tepat satu kandidat (hindari salah cocok di org tim)
    const org = cookieValue(cookies, "lastActiveOrg");
    if (org) {
      const hits = candidates.filter(({ a }) => cookieValue(a.cookies, "lastActiveOrg") === org);
      if (hits.length === 1) return hits[0].i;
    }

    return -1;
  }

  // Sinkronkan cookie terbaru ke akun yang sedang aktif
  async function syncActiveAccountCookies() {
    const { accounts, activeAccountId } = await getStorageData();
    if (!activeAccountId) return { accounts, activeAccountId };

    const activeIdx = accounts.findIndex((a) => a.id === activeAccountId);
    if (activeIdx === -1) return { accounts, activeAccountId };

    const currentCookies = await getClaudeCookies();
    if (currentCookies.length === 0) return { accounts, activeAccountId };

    const acc = accounts[activeIdx];

    // Jika tersimpan punya sessionKey tapi sekarang tidak (logout), jangan timpa data bagus
    if (hasSessionKey(acc.cookies) && !hasSessionKey(currentCookies)) {
      return { accounts, activeAccountId };
    }

    const prevSig = getSessionSignature(acc.cookies || []);
    const currSig = getSessionSignature(currentCookies);
    const sameSession = Boolean(prevSig && currSig && prevSig === currSig);
    let shouldUpdate = sameSession || !prevSig || !currSig;
    let ident = null;

    if (!shouldUpdate || !accHasIdentity(acc)) {
      ident = await fetchCurrentIdentity();
      if (ident.status === "ok" && identityMatches(acc, ident)) shouldUpdate = true;
    }

    if (shouldUpdate) {
      acc.cookies = currentCookies;
      if (ident && ident.status === "ok" && (sameSession || identityMatches(acc, ident) || !accHasIdentity(acc))) {
        if (sameSession || identityMatches(acc, ident)) applyIdentity(acc, ident);
      }
      await saveStorageData(accounts, activeAccountId);
    }
    return { accounts, activeAccountId };
  }

  // Simpan sesi yang sedang aktif. Jika akunnya sudah ada -> UPDATE di tempat (nama & posisi tetap).
  async function saveCurrentSession(customName) {
    setStatus("Membaca sesi Claude...", 1500);
    const cookies = await getClaudeCookies();

    if (cookies.length === 0) {
      setStatus("Tidak ditemukan cookie claude.ai! Pastikan sudah buka & login di claude.ai.");
      return false;
    }

    const ident = await fetchCurrentIdentity();
    if (ident.status === "loggedout") {
      setStatus("Belum login di claude.ai. Login dulu, lalu klik '+ Simpan Sesi Ini'.");
      return false;
    }

    const stored = await getStorageData();
    let idx = findAccountIndex(stored.accounts, ident, cookies);

    // Tidak ada yang cocok, tapi ada akun aktif yang mungkin sama (akun lama tanpa identitas / API tidak bisa dibaca)
    if (idx === -1 && stored.activeAccountId) {
      const activeIdx = stored.accounts.findIndex((a) => a.id === stored.activeAccountId);
      if (activeIdx !== -1) {
        const activeAcc = stored.accounts[activeIdx];
        const canRuleOut = ident.status === "ok" && accHasIdentity(activeAcc);
        if (!canRuleOut) {
          const doUpdate = await askInlineConfirm(
            `Sesi ini sepertinya akun aktif "${activeAcc.name}" yang login ulang. Update datanya (posisi tetap) atau simpan sebagai akun baru?`,
            `Update "${activeAcc.name}"`.slice(0, 22),
            "Akun Baru"
          );
          if (doUpdate) idx = activeIdx;
        }
      }
    }

    // Ambil data terbaru lagi (modal di atas bisa memakan waktu)
    const latest = await getStorageData();

    if (idx !== -1) {
      const target = stored.accounts[idx];
      const liveIdx = latest.accounts.findIndex((a) => a.id === target.id);
      if (liveIdx !== -1) {
        const acc = latest.accounts[liveIdx];
        acc.cookies = cookies; // id, nama, dan urutan TIDAK berubah
        applyIdentity(acc, ident);
        await saveStorageData(latest.accounts, acc.id);
        await renderAccounts();
        setStatus(`Akun "${acc.name}" diperbarui (posisi tetap, ${cookies.length} cookies).`);
        return true;
      }
    }

    const defaultName = `Akun ${latest.accounts.length + 1}`;
    const rawName = customName || (await askInlinePrompt("Beri nama akun untuk sesi ini:", defaultName));
    if (!rawName || !rawName.trim()) {
      setStatus("Penyimpanan sesi dibatalkan.", 2000);
      return false;
    }

    const name = rawName.trim();
    const newId = newAccountId();
    const fresh = await getStorageData();
    const entry = { id: newId, name, cookies };
    applyIdentity(entry, ident);
    fresh.accounts.push(entry);

    await saveStorageData(fresh.accounts, newId);
    await renderAccounts();
    setStatus(`Akun "${name}" berhasil disimpan! (${cookies.length} cookies)`);
    return true;
  }

  // Pindah ke akun yang diklik
  async function switchAccount(accId) {
    const { accounts } = await syncActiveAccountCookies();

    const target = accounts.find((a) => a.id === accId);
    if (!target) return;

    setStatus(`Beralih ke ${target.name}...`);
    await restoreClaudeCookies(target.cookies);
    await saveStorageData(accounts, accId);
    await renderAccounts();

    await navigateOrOpenClaude("https://claude.ai/new", true);
    setStatus(`Aktif: ${target.name}`);
  }

  // Klik "+ Add": Simpan sesi lama (opsional) atau langsung buat slot & buka halaman login
  async function handleAddAccount() {
    const { accounts } = await getStorageData();
    const currentCookies = await getClaudeCookies();
    const ident = await fetchCurrentIdentity();
    const hasActiveSession =
      ident.status !== "loggedout" &&
      currentCookies.some((c) => c.name === "sessionKey" || c.name === "lastActiveOrg");
    const matchIdx = hasActiveSession ? findAccountIndex(accounts, ident, currentCookies) : -1;

    if (hasActiveSession && matchIdx === -1) {
      // Sesi login yang belum tersimpan: tanyakan lewat Inline Modal (bukan window.confirm)
      const wantSave = await askInlineConfirm(
        "Sesi saat ini belum disimpan. Simpan dulu sebelum ganti ke akun baru?",
        "Simpan Dulu",
        "Lewati & Reset"
      );
      if (wantSave) {
        const saved = await saveCurrentSession();
        if (!saved) return;
      }
    } else if (hasActiveSession && matchIdx !== -1 && hasSessionKey(currentCookies)) {
      // Akun sudah tersimpan: perbarui datanya di tempat sebelum reset
      const latest = await getStorageData();
      const target = accounts[matchIdx];
      const live = latest.accounts.find((a) => a.id === target.id);
      if (live) {
        live.cookies = currentCookies;
        applyIdentity(live, ident);
        await saveStorageData(latest.accounts, latest.activeAccountId);
      }
    }

    setStatus("Membersihkan sesi & membuka halaman login baru...");
    await clearClaudeCookies();
    const updated = await getStorageData();
    await saveStorageData(updated.accounts, null);
    await renderAccounts();

    await navigateOrOpenClaude("https://claude.ai/login", false);
    setStatus("Silakan login akun baru, lalu klik '+ Simpan Sesi Ini'.");
  }

  // Hapus akun dari kotak
  async function deleteAccount(e, accId) {
    e.stopPropagation();
    const { accounts, activeAccountId } = await getStorageData();
    const target = accounts.find((a) => a.id === accId);
    if (!target) return;

    const ok = await askInlineConfirm(`Hapus akun "${target.name}" dari daftar?`, "Hapus", "Batal");
    if (!ok) return;

    const filtered = accounts.filter((a) => a.id !== accId);
    const nextActive = activeAccountId === accId ? null : activeAccountId;
    await saveStorageData(filtered, nextActive);
    await renderAccounts();
    setStatus(`Akun "${target.name}" dihapus.`);
  }

  // Render Grid Kotak-Kotak Kecil (4 kolom)
  async function renderAccounts() {
    const { accounts, activeAccountId } = await getStorageData();
    accTitleCount.textContent = accounts.length > 0 ? `Accounts (${accounts.length})` : "Accounts";
    accountGrid.innerHTML = "";

    accounts.forEach((acc) => {
      const box = document.createElement("div");
      box.className = `acc-box ${acc.id === activeAccountId ? "active" : ""}`;
      box.title = `Klik untuk pindah ke ${acc.name}`;

      const delBtn = document.createElement("button");
      delBtn.className = "acc-del";
      delBtn.title = "Hapus akun";
      delBtn.innerHTML = "&times;";
      delBtn.addEventListener("click", (e) => deleteAccount(e, acc.id));

      const avatar = document.createElement("div");
      avatar.className = "acc-avatar";
      avatar.textContent = (acc.name[0] || "A").toUpperCase();

      const nameEl = document.createElement("div");
      nameEl.className = "acc-name";
      nameEl.textContent = acc.name;

      box.appendChild(delBtn);
      box.appendChild(avatar);
      box.appendChild(nameEl);

      box.addEventListener("click", () => switchAccount(acc.id));
      accountGrid.appendChild(box);
    });

    // Kotak "+ Add" di urutan terakhir
    const addBox = document.createElement("div");
    addBox.className = "acc-box add-btn";
    addBox.title = "Bersihkan sesi & login ke akun Claude baru";
    addBox.innerHTML = `
      <div class="add-icon">+</div>
      <div class="acc-name">Add</div>
    `;
    addBox.addEventListener("click", handleAddAccount);
    accountGrid.appendChild(addBox);
  }

  // =========================================================================
  // 4. EXPOR / IMPOR EXTENSION DATA (PINDAH BROWSER TANPA HILANG AKUN)
  //    Ada 3 jalur impor supaya selalu ada yang jalan di Android & Desktop:
  //    a) Impor File  -> dibuka di tab penuh (popup sering tertutup saat file picker muncul)
  //    b) Tempel Impor -> tempel teks JSON, tanpa file picker sama sekali
  //    c) Copy Backup  -> pasangan dari (b) untuk sisi ekspor
  // =========================================================================
  const BACKUP_VERSION = "3.0";

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return "?";
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  function newAccountId() {
    return "acc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  }

  async function buildBackupPayload() {
    const { accounts, activeAccountId } = await syncActiveAccountCookies();
    if (!accounts || accounts.length === 0) return null;
    return {
      app: "ClaudeShadow v3",
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      activeAccountId,
      accounts
    };
  }

  async function exportExtensionData() {
    const payload = await buildBackupPayload();
    if (!payload) {
      setStatus("Belum ada akun tersimpan untuk diekspor!");
      return;
    }

    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);

    const a = document.createElement("a");
    a.href = url;
    a.download = `claude-accounts-backup-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Jangan cabut blob URL terlalu cepat: di Android download kadang baru mulai setelah beberapa detik
    setTimeout(() => URL.revokeObjectURL(url), 30000);

    setStatus(`Berhasil ekspor ${payload.accounts.length} akun! (${formatSize(jsonStr.length)})`);
  }

  async function copyBackupData() {
    const payload = await buildBackupPayload();
    if (!payload) {
      setStatus("Belum ada akun tersimpan untuk disalin!");
      return;
    }
    const jsonStr = JSON.stringify(payload);
    await copyTextUniversal(jsonStr);
    setStatus(`Backup ${payload.accounts.length} akun disalin (${formatSize(jsonStr.length)}). Di browser tujuan: Tempel Impor.`, 8000);
  }

  // ---- Parser backup yang toleran: BOM, ```json fence, teks pembuka, array polos, 1 akun ----
  function parseBackupText(raw) {
    let text = String(raw ?? "").replace(/^\uFEFF/, "").trim();
    if (!text) throw new Error("isinya kosong (0 karakter)");

    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (firstErr) {
      const startIdx = text.search(/[\[{]/);
      const endIdx = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
      if (startIdx !== -1 && endIdx > startIdx) {
        try {
          parsed = JSON.parse(text.slice(startIdx, endIdx + 1));
        } catch (e) {
          parsed = undefined;
        }
      }
      if (parsed === undefined) {
        throw new Error("bukan JSON yang valid (" + firstErr.message + ")");
      }
    }

    let list = null;
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed && Array.isArray(parsed.accounts)) list = parsed.accounts;
    else if (parsed && Array.isArray(parsed.cookies)) list = [parsed];
    if (!list) throw new Error('format tidak dikenali (tidak ada daftar "accounts")');

    const accounts = [];
    list.forEach((a, i) => {
      if (!a || typeof a !== "object" || !Array.isArray(a.cookies)) return;
      const cookies = a.cookies.filter((c) => c && typeof c.name === "string" && c.name);
      if (cookies.length === 0) return;
      accounts.push({
        id: typeof a.id === "string" && a.id ? a.id : null,
        name: (typeof a.name === "string" && a.name.trim()) || `Akun Impor ${i + 1}`,
        identityUuid: typeof a.identityUuid === "string" && a.identityUuid ? a.identityUuid : null,
        identityEmail: typeof a.identityEmail === "string" && a.identityEmail ? a.identityEmail : null,
        cookies
      });
    });

    if (accounts.length === 0) throw new Error("tidak ada akun dengan cookie valid di data ini");
    return { accounts, total: list.length };
  }

  async function mergeImportedAccounts(importedAccounts) {
    const { accounts: currentAccounts, activeAccountId: currentActiveId } = await getStorageData();
    const merged = [...currentAccounts];
    let addedCount = 0;
    let updatedCount = 0;

    for (const imp of importedAccounts) {
      const impSig = getSessionSignature(imp.cookies);
      const existingIdx = merged.findIndex(
        (curr) =>
          (imp.id && curr.id === imp.id) ||
          identityMatches(curr, { uuid: imp.identityUuid, email: imp.identityEmail }) ||
          (impSig && getSessionSignature(curr.cookies || []) === impSig)
      );

      if (existingIdx !== -1) {
        merged[existingIdx] = {
          ...merged[existingIdx],
          name: imp.name || merged[existingIdx].name,
          identityUuid: imp.identityUuid || merged[existingIdx].identityUuid || null,
          identityEmail: imp.identityEmail || merged[existingIdx].identityEmail || null,
          cookies: imp.cookies
        };
        updatedCount++;
      } else {
        const idTaken = imp.id && merged.some((m) => m.id === imp.id);
        merged.push({
          id: imp.id && !idTaken ? imp.id : newAccountId(),
          name: imp.name,
          identityUuid: imp.identityUuid || null,
          identityEmail: imp.identityEmail || null,
          cookies: imp.cookies
        });
        addedCount++;
      }
    }

    // Kotak "aktif" hanya untuk akun yang benar-benar cocok dengan sesi browser ini
    let nextActiveId = merged.some((a) => a.id === currentActiveId) ? currentActiveId : null;
    if (!nextActiveId) {
      try {
        const sig = getSessionSignature(await getClaudeCookies());
        if (sig) {
          nextActiveId = merged.find((a) => getSessionSignature(a.cookies || []) === sig)?.id || null;
        }
      } catch (e) {}
    }

    await saveStorageData(merged, nextActiveId);

    // Verifikasi data benar-benar tersimpan (supaya tidak "sukses palsu")
    const check = await getStorageData();
    if (check.accounts.length < merged.length) {
      throw new Error("browser gagal menyimpan data (chrome.storage). Coba lagi.");
    }

    await renderAccounts();
    return { addedCount, updatedCount, total: merged.length };
  }

  async function importFromText(rawText) {
    let backup;
    try {
      backup = parseBackupText(rawText);
    } catch (err) {
      setStatus("Gagal impor: " + err.message, 0);
      return false;
    }

    try {
      const { addedCount, updatedCount, total } = await mergeImportedAccounts(backup.accounts);
      setStatus(`Impor selesai! +${addedCount} akun baru, ${updatedCount} diperbarui. Total sekarang ${total} akun.`, 9000);
      return true;
    } catch (err) {
      setStatus("Gagal menyimpan hasil impor: " + err.message, 0);
      return false;
    }
  }

  function readFileAsText(file) {
    const viaFileReader = () =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("FileReader gagal membaca file"));
        reader.readAsText(file);
      });

    if (typeof file.text === "function") {
      return file.text().catch(viaFileReader);
    }
    return viaFileReader();
  }

  async function importExtensionFile(file) {
    if (!file) return;
    setStatus(`Membaca "${file.name}" (${formatSize(file.size)})...`, 0);
    try {
      if (file.size === 0) {
        setStatus("Gagal impor: file kosong (0 byte). Kalau dari cloud/Drive, unduh dulu ke penyimpanan HP.", 0);
        return;
      }
      const text = await readFileAsText(file);
      await importFromText(text);
    } catch (err) {
      setStatus("Gagal membaca file: " + err.message, 0);
    } finally {
      importFileInput.value = "";
    }
  }

  // ---- Panel Tempel Impor ----
  function showPastePanel() {
    pastePanel.classList.add("show");
    setTimeout(() => pasteArea.focus(), 30);
  }

  function hidePastePanel() {
    pastePanel.classList.remove("show");
    pasteArea.value = "";
  }

  // ---- Deteksi: halaman ini popup biasa atau sudah berupa tab? ----
  // Di popup, file picker sering menutup popup (Android & Chrome Mac/Linux) sebelum event "change" sempat jalan.
  async function detectRunningInTab() {
    if (isFullTabView) return true;
    try {
      const current = await chrome.tabs.getCurrent();
      return Boolean(current);
    } catch (e) {
      return false;
    }
  }

  async function openImportTab() {
    setStatus("Membuka halaman impor di tab baru...", 3000);
    await chrome.tabs.create({
      url: chrome.runtime.getURL("popup.html?view=tab&focus=import"),
      active: true
    });
    setTimeout(() => {
      try {
        window.close();
      } catch (e) {}
    }, 400);
  }

  // Bungkus handler supaya error apa pun tampil di status (tidak diam-diam)
  const safe = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      setStatus("Error: " + (err?.message || err), 0);
    }
  };

  const runningInTab = await detectRunningInTab();

  if (runningInTab) {
    // Tab penuh: input file asli aktif & langsung di-tap (user gesture langsung ke input)
    importFileInput.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) importExtensionFile(file);
    });
    if (new URLSearchParams(location.search).get("focus") === "import") {
      setStatus('Tap "Impor File" lalu pilih file backup .json (atau pakai Tempel Impor).', 12000);
    }
  } else {
    // Popup biasa: nonaktifkan input, tombol membuka tab penuh untuk impor file
    importFileInput.disabled = true;
    importFileLabel.addEventListener("click", (e) => {
      e.preventDefault();
      safe(openImportTab)();
    });
  }

  exportDataBtn.addEventListener("click", safe(exportExtensionData));
  copyBackupBtn.addEventListener("click", safe(copyBackupData));
  pasteImportBtn.addEventListener("click", () => {
    if (pastePanel.classList.contains("show")) hidePastePanel();
    else showPastePanel();
  });
  pasteCancelBtn.addEventListener("click", hidePastePanel);
  pasteConfirmBtn.addEventListener(
    "click",
    safe(async () => {
      const raw = pasteArea.value;
      if (!raw.trim()) {
        setStatus("Kolom masih kosong. Tempel teks backup dulu.", 3000);
        return;
      }
      const ok = await importFromText(raw);
      if (ok) hidePastePanel();
    })
  );

  saveCurrentBtn.addEventListener("click", safe(() => saveCurrentSession()));
  await renderAccounts();
});
