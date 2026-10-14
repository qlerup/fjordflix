/* One compressed segment ahead of HLS, outside the decoder's bounded MSE queue. */
const FjordBrowserPrefetch = {
  create(Hls, profile) {
    if (profile?.id !== 'firefox-desktop' || profile.external || !profile.prefetchMiB) return null;
    const Base = Hls.DefaultConfig.loader, limit = profile.prefetchMiB * 1024 ** 2;
    let hls, queued = null, closed = false;
    const active = new Set();
    function clear() {
      const entry = queued; queued = null;
      if (entry) { entry.cancelled = true; entry.loader.destroy(); }
    }
    function next(context) {
      const frag = context.frag;
      if (closed || context.part || frag?.type !== 'main' || !Number.isInteger(frag.sn) ||
          context.rangeEnd || frag.decryptdata || frag.gap) return null;
      const fragments = hls?.levels[frag.level]?.details?.fragments || [];
      const candidate = fragments.find(f => f.sn === frag.sn + 1);
      if (!candidate?.url || candidate.gap || candidate.decryptdata || candidate.byteRangeEndOffset) return null;
      return candidate;
    }
    function prefetch(context, config, settings) {
      const frag = next(context);
      if (!frag || queued) return;
      const entry = {url:frag.url, loader:null, result:null, listener:null, cancelled:false};
      queued = entry;
      const prefetchConfig = {...settings, xhrSetup:async (xhr, url) => {
        await settings.xhrSetup?.(xhr, url);
        const tooLarge = () => {
          if (!entry.oversized) { entry.oversized = true; entry.loader.abort(); }
        };
        xhr.addEventListener('readystatechange', () => {
          if (xhr.readyState === 2 && Number(xhr.getResponseHeader('Content-Length')) > limit) tooLarge();
        });
        xhr.addEventListener('progress', event => {
          if (event.loaded > limit || event.lengthComputable && event.total > limit) {
            tooLarge();
          }
        });
      }};
      const loader = entry.loader = new Base(prefetchConfig);
      const finish = result => {
        if (entry.cancelled || entry.result) return;
        entry.result = result;
        entry.listener?.(result);
      };
      loader.load({frag, part:null, url:frag.url, responseType:'arraybuffer', headers:{}, rangeStart:0, rangeEnd:0},
        {...config}, {
          onSuccess:(response, stats, _, network) => finish(response.data.byteLength <= limit
            ? {response, stats, network} : {failed:true}),
          onError:() => finish({failed:true}), onTimeout:() => finish({failed:true}),
          onAbort:() => finish({failed:true})
        });
    }
    class Loader extends Base {
      constructor(settings) { super(settings); this.settings = settings; this.entry = null; this.completed = false; }
      load(context, config, callbacks) {
        this.context = context;
        const entry = queued?.url === context.url && !context.part && !context.rangeEnd ? queued : null;
        if (queued && !entry) clear();
        if (!entry) {
          prefetch(context, config, this.settings);
          return super.load(context, config, {...callbacks, onSuccess:(...args) => {
            this.completed = true; callbacks.onSuccess(...args);
          }});
        }
        queued = null; this.entry = entry; this.consumerCallbacks = callbacks; active.add(entry);
        const deliver = result => {
          if (closed || entry.cancelled || this.completed) return;
          active.delete(entry); this.entry = null;
          if (result.failed) {
            entry.loader.destroy();
            // Let HLS report/retry an actual failed demand request normally.
            super.load(context, config, {...callbacks, onSuccess:(...args) => {
              this.completed = true; callbacks.onSuccess(...args);
            }});
            return;
          }
          Object.assign(this.stats, result.stats);
          this.completed = true;
          callbacks.onProgress?.(this.stats, context, result.response.data, result.network);
          callbacks.onSuccess(result.response, this.stats, context, result.network);
          entry.loader.destroy();
        };
        entry.listener = deliver;
        prefetch(context, config, this.settings);
        if (entry.result) queueMicrotask(() => deliver(entry.result));
      }
      abort() {
        clear();
        if (this.entry) {
          const entry = this.entry; this.entry = null; active.delete(entry);
          entry.cancelled = true; entry.loader.destroy(); this.stats.aborted = true;
          this.consumerCallbacks?.onAbort?.(this.stats, this.context, null);
        }
        super.abort();
      }
      destroy() {
        if (!this.completed && this.entry) this.abort();
        super.destroy();
      }
    }
    return {Loader, attach(instance) {
      hls = instance;
      instance.on(Hls.Events.DESTROYING, () => {
        closed = true; clear();
        for (const entry of active) { entry.cancelled = true; entry.loader.destroy(); }
        active.clear();
      });
    }};
  }
};
if (typeof module !== 'undefined') module.exports = FjordBrowserPrefetch;
