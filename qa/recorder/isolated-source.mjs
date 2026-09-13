import { CAPTURE_LIMITS } from "./resources.mjs";

export function isolatedInstallerSource(bindingName) {
  return `(() => {
    if (globalThis.__qaIsolatedRecorderInstalled) return;
    Object.defineProperty(globalThis, "__qaIsolatedRecorderInstalled", { value: true });
    const binding = globalThis[${JSON.stringify(bindingName)}];
    if (typeof binding !== "function") return;
    const controlSelector = "input,select,textarea,button,[role]";
    const composedParent = (element) => element.parentElement ||
      (element.getRootNode() instanceof ShadowRoot ? element.getRootNode().host : null);
    const roots = new WeakSet();
    const observeRoot = (root) => {
      if (roots.has(root)) return;
      roots.add(root);
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.shadowRoot) observeRoot(node.shadowRoot);
            for (const child of node.querySelectorAll("*")) {
              if (child.shadowRoot) observeRoot(child.shadowRoot);
            }
          }
        }
        binding(JSON.stringify({ messageType: "document-state" }));
      });
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) observeRoot(element.shadowRoot);
      }
    };
    observeRoot(document);
    const labelFor = (element) => {
      const aria = element.getAttribute("aria-label");
      if (aria) return aria;
      const labelled = element.getAttribute("aria-labelledby");
      if (labelled) {
        const label = labelled.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ").trim();
        if (label) return label;
      }
      if (element.labels?.length) return Array.from(element.labels).map((label) => label.innerText).join(" ").trim();
      if (element instanceof HTMLButtonElement) return element.innerText.trim();
      return element.getAttribute("name") || element.getAttribute("placeholder") || "Unlabelled control";
    };
    const roleFor = (element) => {
      if (element.getAttribute("role")) return element.getAttribute("role");
      if (element instanceof HTMLButtonElement) return "button";
      if (element instanceof HTMLSelectElement) return "combobox";
      if (element instanceof HTMLTextAreaElement) return "textbox";
      if (element instanceof HTMLInputElement) {
        if (element.type === "checkbox") return "checkbox";
        if (element.type === "radio") return "radio";
        if (element.type === "file") return "file";
        return "textbox";
      }
      return "control";
    };
    const isVisible = (element) => {
      if (element.matches("input[type=hidden],input[type=password]")) return false;
      for (let current = element; current instanceof Element; current = composedParent(current)) {
        if (current.matches("[hidden],[aria-hidden=true]")) return false;
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" ||
            style.visibility === "collapse" || Number.parseFloat(style.opacity) === 0 ||
            style.contentVisibility === "hidden") return false;
      }
      const rectangle = element.getBoundingClientRect();
      if (rectangle.width <= 0 || rectangle.height <= 0) return false;
      const style = getComputedStyle(element);
      if (style.position === "fixed") {
        return rectangle.bottom > 0 && rectangle.right > 0 &&
          rectangle.top < innerHeight && rectangle.left < innerWidth;
      }
      return rectangle.right + scrollX > 0 && rectangle.bottom + scrollY > 0;
    };
    for (const interactionType of ["click", "change", "input"]) {
      document.addEventListener(interactionType, (event) => {
        if (!event.isTrusted) return;
        const source = event.composedPath().find((node) => node instanceof Element);
        const element = source instanceof Element ? source.closest(controlSelector) : null;
        if (!element || !isVisible(element)) return;
        let label = labelFor(element).slice(0, 256);
        const mutable = [];
        if ("value" in element && typeof element.value === "string" && element.value) {
          mutable.push(element.value);
        }
        if (element instanceof HTMLInputElement && element.files) {
          for (const file of element.files) if (file.name) mutable.push(file.name);
        }
        if (element instanceof HTMLSelectElement) {
          for (const option of element.selectedOptions) {
            if (option.value) mutable.push(option.value);
            if (option.text) mutable.push(option.text);
          }
        }
        const normalizeMutable = (value) => value.normalize("NFKC")
          .toLocaleLowerCase("und").replaceAll("ß", "ss").replaceAll("ς", "σ")
          .replace(/\s+/g, " ").trim();
        const compactMutable = (value) => normalizeMutable(value)
          .replace(/[^\\p{L}\\p{N}]+/gu, "");
        const normalizedLabel = normalizeMutable(label);
        const compactLabel = compactMutable(label);
        const exposesMutable = mutable.some((value) => {
          const normalized = normalizeMutable(value);
          if (!normalized) return false;
          if (normalizedLabel.includes(normalized)) return true;
          const compact = compactMutable(value);
          if (compact.length >= 4 && compactLabel.includes(compact)) return true;
          return compact.length >= 8 && (
            compactLabel.includes(compact.slice(0, 6)) ||
            compactLabel.includes(compact.slice(-6))
          );
        });
        if (exposesMutable) label = "";
        const observed = {
          messageType: "interaction",
          interactionType,
          role: roleFor(element),
          label,
          required: element.matches("[required],[aria-required=true]"),
        };
        queueMicrotask(() => {
          binding(JSON.stringify(observed));
        });
      }, true);
    }
  })()`;
}

export function isolatedSnapshotSource(includeStructure) {
  return `(() => {
    const denied = /(?:password|passcode|captcha|multi[ -]?factor|\\bmfa\\b|\\b2fa\\b|2[ -]?step verification|\\botp\\b|authentication|authenticator app|push notification|verify (?:your )?identity|\\b\\d{1,2}[ -]?digit code(?: we sent)?|recovery code|sms code|security code|challenge|security[ -]?key|one[ -]?time[ -]?code|authorization|bearer|cookie|session|csrf|token)/i;
    const controlSelector = "input,select,textarea,button,[role]";
    const composedParent = (element) => element.parentElement ||
      (element.getRootNode() instanceof ShadowRoot ? element.getRootNode().host : null);
    const collectControls = (root, controls = []) => {
      for (const element of root.querySelectorAll("*")) {
        if (element.matches(controlSelector)) controls.push(element);
        if (element.shadowRoot) {
          collectControls(element.shadowRoot, controls);
        }
      }
      return controls;
    };
    let pageText = "";
    const collectPageText = (node) => {
      if (!node || pageText.length >= 8192) return;
      if (node.nodeType === Node.TEXT_NODE) {
        pageText += (pageText ? " " : "") + (node.textContent || "");
        pageText = pageText.slice(0, 8192);
        return;
      }
      if (node instanceof Element && node.matches("script,style,template")) return;
      for (const child of node.childNodes) collectPageText(child);
      if (node instanceof Element && node.shadowRoot) collectPageText(node.shadowRoot);
    };
    const labelFor = (element) => {
      const aria = element.getAttribute("aria-label");
      if (aria) return aria;
      const labelled = element.getAttribute("aria-labelledby");
      if (labelled) {
        const root = element.getRootNode();
        const label = labelled.split(/\\s+/).map((id) =>
          (root.getElementById?.(id) || document.getElementById(id))?.innerText || ""
        ).join(" ").trim();
        if (label) return label;
      }
      if (element.labels?.length) return Array.from(element.labels).map((label) => label.innerText).join(" ").trim();
      if (element instanceof HTMLButtonElement) return element.innerText.trim();
      return element.getAttribute("name") || element.getAttribute("placeholder") || "Unlabelled control";
    };
    const roleFor = (element) => {
      if (element.getAttribute("role")) return element.getAttribute("role");
      if (element instanceof HTMLButtonElement) return "button";
      if (element instanceof HTMLSelectElement) return "combobox";
      if (element instanceof HTMLTextAreaElement) return "textbox";
      if (element instanceof HTMLInputElement) {
        if (element.type === "checkbox") return "checkbox";
        if (element.type === "radio") return "radio";
        if (element.type === "file") return "file";
        return "textbox";
      }
      return "control";
    };
    const isVisible = (element) => {
      if (element.matches("input[type=hidden],input[type=password]")) return false;
      for (let current = element; current instanceof Element; current = composedParent(current)) {
        if (current.matches("[hidden],[aria-hidden=true]")) return false;
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" ||
            style.visibility === "collapse" || Number.parseFloat(style.opacity) === 0 ||
            style.contentVisibility === "hidden") return false;
      }
      const rectangle = element.getBoundingClientRect();
      if (rectangle.width <= 0 || rectangle.height <= 0) return false;
      const elementStyle = getComputedStyle(element);
      if (elementStyle.position === "fixed") {
        return rectangle.bottom > 0 && rectangle.right > 0 &&
          rectangle.top < innerHeight && rectangle.left < innerWidth;
      }
      return rectangle.right + scrollX > 0 && rectangle.bottom + scrollY > 0;
    };
    const elements = collectControls(document);
    const describe = (element) => ({
      type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
      autocomplete: element.getAttribute("autocomplete") || "",
      label: labelFor(element).slice(0, 256),
      role: roleFor(element).slice(0, 64),
      required: element.matches("[required],[aria-required=true]"),
    });
    const securityControls = elements.slice(0, ${CAPTURE_LIMITS.maxControls + 1}).map(describe);
    const visibleElements = elements.filter(isVisible);
    const controls = visibleElements.slice(0, ${CAPTURE_LIMITS.maxControls + 1}).map(describe);
    const formCount = document.querySelectorAll("form").length;
    const iframeOwners = Array.from(document.querySelectorAll("iframe"));
    const securityFrames = iframeOwners.slice(0, 4).map((frame) => {
      const style = getComputedStyle(frame);
      const rectangle = frame.getBoundingClientRect();
      return {
        src: (frame.getAttribute("src") || "").slice(0, 2048),
        title: (frame.getAttribute("title") || "").slice(0, 512),
        visibility: style.visibility,
        position: style.position,
        width: rectangle.width,
        height: rectangle.height,
      };
    });
    collectPageText(document.body);
    let html = "";
    let structuralOverflow = false;
    if (${includeStructure ? "true" : "false"}) {
      const allowed = new Set(["html","body","main","section","article","div","form","fieldset","legend","label","h1","h2","h3","h4","h5","h6","p","span","ul","ol","li","button","input","select","option","textarea"]);
      const allowedAttributes = new Set(["role","aria-label","aria-required","required","type","name","autocomplete"]);
      const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
      let nodes = 0;
      const serialize = (node) => {
        if (++nodes > 5000) { structuralOverflow = true; return ""; }
        if (node.nodeType === Node.TEXT_NODE) {
          const text = (node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 512);
          return !text || denied.test(text) ? "" : escape(text);
        }
        if (!(node instanceof Element)) return "";
        const tag = node.tagName.toLowerCase();
        if (!allowed.has(tag)) return "";
        if (node.matches("[hidden],[aria-hidden=true],input[type=hidden],input[type=password]")) return "";
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return "";
        const attributes = [];
        for (const attribute of node.attributes) {
          const name = attribute.name.toLowerCase();
          if (!allowedAttributes.has(name) || ["value","checked","selected"].includes(name)) continue;
          if (denied.test(name) || denied.test(attribute.value)) continue;
          attributes.push(attribute.value === "" ? name : name + '=\"' + escape(attribute.value.slice(0, 256)) + '\"');
        }
        let children = "";
        for (const child of node.childNodes) children += serialize(child);
        if (node.shadowRoot) {
          for (const child of node.shadowRoot.childNodes) children += serialize(child);
        }
        const result = "<" + tag + (attributes.length ? " " + attributes.join(" ") : "") + ">" + children + "</" + tag + ">";
        if (result.length > ${CAPTURE_LIMITS.maxHtmlBytes + 1}) structuralOverflow = true;
        return result.slice(0, ${CAPTURE_LIMITS.maxHtmlBytes + 1});
      };
      html = "<!doctype html>" + serialize(document.documentElement);
    }
    return {
      title: document.title.slice(0, 512),
      text: pageText,
      controls,
      securityControls,
      controlOverflow: elements.length > ${CAPTURE_LIMITS.maxControls},
      formCount,
      securityFrames,
      securityFrameOverflow: iframeOwners.length > 3,
      html,
      structuralOverflow,
      width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    };
  })()`;
}
