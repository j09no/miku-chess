(function(){
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  function mockReq(method, url, body) {
    var ls = {};
    var req = { method: method, url: url, on: function(ev, cb){ ls[ev] = cb; return req; } };
    Promise.resolve().then(function(){
      try {
        if (ls.data && body != null) ls.data(body);
        if (ls.end) ls.end();
      } catch(e) { console.error('shim req err', e); }
    });
    return req;
  }
  function mockRes() {
    var doneResolve;
    var done = new Promise(function(r){ doneResolve = r; });
    var headers = {};
    var res = {
      statusCode: 200,
      setHeader: function(k, v){ headers[k] = v; },
      writeHead: function(code, h){ this.statusCode = code; if (h) Object.assign(headers, h); },
      end: function(d){ this._body = (d == null ? '' : d); doneResolve(); },
      done: done, headers: headers
    };
    return res;
  }
  window.fetch = async function(url, opts) {
    opts = opts || {};
    var u = new URL(url, location.href);
    if (u.pathname === '/api' || u.pathname.indexOf('/api/') === 0) {
      var body = null;
      if (opts.body != null) body = (typeof opts.body === 'string') ? opts.body : JSON.stringify(opts.body);
      var res = mockRes();
      Promise.resolve().then(function(){
        try { window.__handler(mockReq(opts.method || 'GET', u.pathname + u.search, body), res); }
        catch(e) { console.error('handler err', e); res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({error: String(e)})); }
      });
      await res.done;
      var out = (typeof res._body === 'string') ? res._body : String(res._body);
      var base = location.pathname.replace(/[^/]*$/, '');
      if (out.indexOf('/voices/') >= 0) {
        out = out.split('"/voices/').join('"' + base + 'voices/');
        out = out.split("'/voices/").join("'" + base + "voices/");
      }
      return new Response(out, { status: res.statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    if (realFetch) return realFetch(url, opts);
    throw new Error('fetch unavailable');
  };
})();
