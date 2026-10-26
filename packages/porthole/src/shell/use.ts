/**
 * The capability runtime in the frame (P085), spliced into the shell's runtime (`__RUNTIME__`)
 * where the config has one (`config.runtime`). Content gets one global, `porthole`, whose only
 * member is `use(name)`: a promise of a frozen namespace of the capability's methods, or null when
 * the capability isn't there for this page (not offered, not declared, no host): the reasons are
 * indistinguishable. Permission problems come at call time, as a rejected promise whose error has
 * a stable `code` (P080, P087) and a sentence to show.
 *
 * The host's offer comes in the handshake (MCP Apps' experimental host capabilities,
 * `porthole/runtime`): which capabilities, which methods. Calls go as `porthole/call` (own-prefixed,
 * P002), `data.read` and `data.subscribe` as MCP's own resource requests (the cache and the
 * subscriptions of P079); a watch's updates come as `porthole/event`. The host's bridge decides
 * every call: nothing here is a wall, since it shares the content's realm.
 */
export const USE_RUNTIME = String.raw`
  // The capability runtime (P085): porthole.use(name) -> a frozen namespace, or null.
  // The host's offer: undefined until the handshake says (or gives up: null). A late answer is
  // still taken, for the calls to use after it (after the review).
  let offered = undefined;
  const waiting = new Set();
  runtimeOffer = (given) => {
    const capabilities = given !== null && typeof given === "object" && given.capabilities !== null && typeof given.capabilities === "object" ? given.capabilities : null;
    if (capabilities !== null || offered === undefined) {
      offered = capabilities;
    }
    for (const wake of Array.from(waiting)) {
      wake();
    }
    waiting.clear();
  };
  // A use waits for the handshake a few seconds at most, then is null (no host is answering).
  const ready = () =>
    offered !== undefined
      ? Promise.resolve()
      : new Promise((resolve) => {
          waiting.add(resolve);
          setTimeout(resolve, 3000);
        });
  // Framed by a page that isn't one of this frame's hosts: nothing will answer (where the engine
  // says who framed it).
  const framedByHost = () => {
    const ancestors = location.ancestorOrigins;
    // "null": the engine masks it (a no-referrer frame): unknown, not a stranger.
    return !ancestors || ancestors.length === 0 || ancestors[0] === "null" || plan.origins.indexOf(ancestors[0]) !== -1;
  };
  const NativeBlob = typeof Blob === "function" ? Blob : null;
  const NativeArrayBuffer = ArrayBuffer;
  const coded = (code, message) => {
    const error = new Error(message);
    error.code = code;
    return error;
  };
  // A call through the host; its value, or a rejection with the refusal's code.
  const call = (capability, method, args) =>
    request("porthole/call", { capability, method, args }).then((result) =>
      result !== null && typeof result === "object" ? result.value : undefined,
    );
  // What needs a click, refused here before it goes (the host checks again: P021).
  const clicked = (serves, what) => (gestured(serves) ? null : Promise.reject(coded("not_allowed", what + " needs a click: call it from a button's handler")));
  // Bytes as base64, for what crosses the frame as JSON.
  const bytesOf = (data) => {
    if (NativeBlob !== null && data instanceof NativeBlob) {
      return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
    }
    if (data instanceof NativeArrayBuffer) {
      return Promise.resolve(new Uint8Array(data));
    }
    if (ArrayBuffer.isView(data)) {
      return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    return null;
  };
  const base64Of = (bytes) => {
    let text = "";
    for (let at = 0; at < bytes.length; at += 32768) {
      text += String.fromCharCode.apply(null, Array.from(bytes.subarray(at, at + 32768)));
    }
    return btoa(text);
  };
  // A file's content: text as it is, bytes as base64, null as null (a removal).
  const fileOf = (value) => {
    if (value === null || typeof value === "string") {
      return Promise.resolve(value === null ? null : { text: value });
    }
    const bytes = bytesOf(value);
    return bytes === null ? Promise.reject(coded("not_allowed", "A file is text, a Blob, an ArrayBuffer or bytes")) : bytes.then((each) => ({ base64: base64Of(each) }));
  };
  const record = (value) => (value !== null && typeof value === "object" ? value : {});
  // Watches (db.onSnapshot): by the id this frame gives each, its listener.
  const watchers = new Map();
  // A watch's id is this page's own, at random: a page that follows another on the same
  // transport can't be handed its watches (after the review).
  const watchId = () => {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return "w" + Array.from(bytes, (each) => each.toString(16).padStart(2, "0")).join("");
  };
  runtimeEvent = (params) => {
    const watcher = typeof params.watch === "string" ? watchers.get(params.watch) : undefined;
    if (watcher === undefined) {
      return;
    }
    try {
      watcher.onData(params.data);
    } catch (error) {
      later(error);
    }
  };
  const watch = (capability, method, args, onData, onError) => {
    if (typeof onData !== "function") {
      throw new TypeError(capability + "." + method + ": onData must be a function");
    }
    const id = watchId();
    watchers.set(id, { onData });
    request("porthole/call", { capability, method, args, watch: id }).catch((error) => {
      watchers.delete(id);
      if (typeof onError === "function") {
        try {
          onError(error);
        } catch (thrown) {
          later(thrown);
        }
      }
    });
    return () => {
      if (watchers.delete(id)) {
        notify("porthole/unwatch", { watch: id });
      }
    };
  };
  const METHODS = {
    user: { get: () => call("user", "get", {}) },
    comments: {
      // The draft goes as the page gave it, for the host to refuse what isn't text (P108): read
      // after the click's check, so a getter that throws is a rejection; options that aren't an
      // object send a null draft, refused.
      open: (anchor, options) =>
        clicked("comments", "comments.open") ||
        Promise.resolve().then(() => {
          const draft = options === undefined || options === null ? undefined : typeof options === "object" ? options.draft : null;
          return call("comments", "open", { anchor: typeof anchor === "string" ? { name: anchor } : record(anchor), ...(draft === undefined ? {} : { draft }) });
        }),
    },
    clipboard: { copy: (text) => clicked("copyText", "clipboard.copy") || call("clipboard", "copy", { text: String(text) }) },
    links: { open: (url) => clicked("openLink", "links.open") || call("links", "open", { url: String(url) }) },
    downloads: {
      save: (file) => {
        const given = record(file);
        const waiting = clicked("downloadFile", "downloads.save");
        if (waiting !== null) {
          return waiting;
        }
        const content = given.data !== undefined ? given.data : given.text !== undefined ? String(given.text) : null;
        return fileOf(content).then((body) => call("downloads", "save", { file: Object.assign({ name: given.name, type: given.type }, record(body)) }));
      },
    },
    chat: { send: (text) => clicked("sendPrompt", "chat.send") || call("chat", "send", { text: String(text) }) },
    data: {
      read: (uri) => readValue(uri),
      subscribe: (uri, onData, onError) => (follow === null ? null : follow(uri, onData, onError)),
      call: (name, args) => call("data", "call", { name: String(name), arguments: args === undefined ? {} : args }),
    },
    context: { set: (update) => call("context", "set", record(update)) },
    artifact: {
      get: () => call("artifact", "get", {}),
      publish: (change) => {
        const given = record(change);
        const files = record(given.files);
        const names = Object.keys(files);
        return Promise.all(names.map((name) => fileOf(files[name]))).then((bodies) => {
          const out = {};
          names.forEach((name, index) => {
            out[name] = bodies[index];
          });
          return call("artifact", "publish", { base: given.base, files: out, entry: given.entry, label: given.label, note: given.note });
        });
      },
    },
    assets: {
      list: () => call("assets", "list", {}),
      upload: (file, options) => {
        const name = record(options).name !== undefined ? record(options).name : file && typeof file.name === "string" ? file.name : undefined;
        const bytes = bytesOf(file);
        return bytes === null ? Promise.reject(coded("not_allowed", "assets.upload takes a File, a Blob or bytes")) : bytes.then((each) => call("assets", "upload", { name, base64: base64Of(each) }));
      },
      delete: (id) => call("assets", "delete", { id: String(id) }),
      // The address that loads an asset in this page now (P091): in a frame, under its own sealed
      // files' address, which every engine sends; elsewhere /_blob/<id>. Never stored: it carries
      // this page's access.
      url: (id) => {
        const asset = String(id);
        if (!/^[0-9a-f]{32}$/.test(asset)) {
          throw new TypeError("assets.url(id): an asset's id is 32 lowercase hex characters");
        }
        return filesBase !== null && filesBase.indexOf("/__porthole/f/") !== -1 ? filesBase + "__porthole/blob/" + asset : "/_blob/" + asset;
      },
    },
    db: {
      get: (path) => call("db", "get", { path }),
      set: (path, data, options) => call("db", "set", { path, data, ifVersion: record(options).ifVersion }),
      update: (path, data, options) => call("db", "update", { path, data, ifVersion: record(options).ifVersion }),
      delete: (path, options) => call("db", "delete", { path, ifVersion: record(options).ifVersion }),
      query: (collection, query) => call("db", "query", Object.assign({ collection }, record(query))),
      batch: (writes) => call("db", "batch", { writes }),
      onSnapshot: (path, onData, onError) => watch("db", "watch", { path }, onData, onError),
    },
  };
  // A runtime method's name in the namespace, where it differs from the contract's.
  const RENAMED = { db: { watch: "onSnapshot" } };
  const namespaces = new Map();
  const use = (name) => {
    if (window.parent === window || !framedByHost() || typeof name !== "string" || !Object.prototype.hasOwnProperty.call(METHODS, name)) {
      return Promise.resolve(null);
    }
    return ready().then(() => {
      const methods = offered !== undefined && offered !== null && Array.isArray(offered[name]) ? offered[name] : null;
      if (methods === null) {
        return null;
      }
      if (!namespaces.has(name)) {
        const space = {};
        const renamed = RENAMED[name] || {};
        for (const each of methods) {
          const key = Object.prototype.hasOwnProperty.call(renamed, each) ? renamed[each] : each;
          if (typeof each === "string" && Object.prototype.hasOwnProperty.call(METHODS[name], key)) {
            const call = METHODS[name][key];
            // A method whose own gates want a gesture (after the review): refused here without one.
            const gated = Array.isArray(plan.methodActivation) && plan.methodActivation.indexOf(name + "." + each) !== -1;
            space[key] = gated
              ? function () {
                  const activation = navigator.userActivation;
                  return activation && !activation.isActive ? Promise.reject(coded("not_allowed", name + "." + key + " needs a click: call it from a button's handler")) : call.apply(null, arguments);
                }
              : call;
          }
        }
        namespaces.set(name, Object.freeze(space));
      }
      return namespaces.get(name);
    }, () => null);
  };
  lock(window, "porthole", Object.freeze({ use }));
`;
