self.addEventListener("message", (event) => self.postMessage(`echo:${event.data}`, []));
