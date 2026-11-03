(function () {
  'use strict';
  var KEY = 'nix-site-theme';
  var root = document.documentElement;
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function current() {
    var chosen = root.getAttribute('data-theme');
    if (chosen === 'light' || chosen === 'dark') return chosen;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  var saved = stored();
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);

  function ready() {
    var toggle = document.querySelector('[data-nix-theme]');
    if (toggle) {
      var label = function () {
        toggle.setAttribute('aria-label', current() === 'dark' ? 'Use the light theme' : 'Use the dark theme');
      };
      label();
      toggle.hidden = false;
      toggle.addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem(KEY, next); } catch (e) { /* private mode: the choice lasts this page */ }
        label();
      });
    }

    // Copy buttons on code blocks and section links. The clipboard needs a secure context; without
    // it nothing is added and the page reads as before.
    if (navigator.clipboard && window.isSecureContext) {
      var said = document.createElement('p');
      said.className = 'sr-only';
      said.setAttribute('aria-live', 'polite');
      document.body.appendChild(said);
      var copy = function (text, shown, done) {
        navigator.clipboard.writeText(text).then(function () {
          var was = shown.textContent;
          shown.textContent = done;
          said.textContent = done;
          setTimeout(function () { shown.textContent = was; said.textContent = ''; }, 1600);
        }, function () { said.textContent = 'Copying is not allowed here.'; });
      };
      Array.prototype.forEach.call(document.querySelectorAll('pre.nix-code'), function (pre) {
        var wrap = document.createElement('div');
        wrap.className = 'nix-code-wrap';
        pre.parentNode.insertBefore(wrap, pre);
        wrap.appendChild(pre);
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'nix-copy';
        button.textContent = 'Copy';
        button.addEventListener('click', function () {
          copy((pre.querySelector('code') || pre).textContent, button, 'Copied');
        });
        wrap.appendChild(button);
      });
      Array.prototype.forEach.call(document.querySelectorAll('.nix-anchor'), function (anchor) {
        anchor.addEventListener('click', function () {
          copy(location.origin + location.pathname + anchor.getAttribute('href'), anchor, 'Link copied');
        });
      });
    }

    var box = document.querySelector('[data-nix-search]');
    if (!box) return;
    var input = box.querySelector('input');
    var panel = box.querySelector('.nix-search-panel');
    var status = panel.querySelector('p');
    var list = panel.querySelector('ul');
    var index = null;
    var loading = null;
    box.hidden = false;

    function load() {
      if (!loading) {
        loading = fetch(box.getAttribute('data-nix-search'), { credentials: 'omit' })
          .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
          .then(function (data) { index = data; return data; });
      }
      return loading;
    }
    function tokens(text) {
      return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(function (t) { return t.length > 1; });
    }
    function search(query) {
      var words = tokens(query);
      if (!words.length) return [];
      var scores = null;
      words.forEach(function (word) {
        var hits = {};
        Object.keys(index.terms).forEach(function (term) {
          if (term.indexOf(word) !== 0) return;
          index.terms[term].forEach(function (doc) { hits[doc] = (hits[doc] || 0) + (term === word ? 2 : 1); });
        });
        // A match in the title outranks one in the body.
        Object.keys(hits).forEach(function (doc) {
          if (index.docs[doc].t.toLowerCase().indexOf(word) !== -1) hits[doc] += 5;
        });
        if (scores === null) { scores = hits; return; }
        var both = {};
        Object.keys(scores).forEach(function (doc) { if (hits[doc]) both[doc] = scores[doc] + hits[doc]; });
        scores = both;
      });
      return Object.keys(scores || {}).map(Number)
        .sort(function (a, b) { return scores[b] - scores[a] || a - b; })
        .slice(0, 8).map(function (doc) { return index.docs[doc]; });
    }
    function render() {
      var query = input.value.trim();
      if (!query) { panel.hidden = true; return; }
      load().then(function () {
        var results = search(query);
        list.textContent = '';
        results.forEach(function (doc) {
          var item = document.createElement('li');
          var link = document.createElement('a');
          link.href = doc.p;
          link.textContent = doc.t;
          var where = document.createElement('small');
          where.textContent = doc.p;
          link.appendChild(where);
          item.appendChild(link);
          list.appendChild(item);
        });
        status.textContent = results.length === 1 ? '1 result' : results.length + ' results';
        panel.hidden = false;
      }, function () {
        status.textContent = 'Search is not available right now.';
        list.textContent = '';
        panel.hidden = false;
      });
    }
    input.addEventListener('input', render);
    input.addEventListener('focus', load);
    // Arrow keys walk the results; Enter in the box opens the first one.
    box.addEventListener('keydown', function (event) {
      var links = Array.prototype.slice.call(list.querySelectorAll('a'));
      if (panel.hidden || !links.length) return;
      var at = links.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        (links[at + 1] || links[links.length - 1]).focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        (at > 0 ? links[at - 1] : input).focus();
      } else if (event.key === 'Enter' && event.target === input) {
        event.preventDefault();
        links[0].click();
      }
    });
    box.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { input.value = ''; panel.hidden = true; input.focus(); }
    });
    document.addEventListener('click', function (event) {
      if (!box.contains(event.target)) panel.hidden = true;
    });
    document.addEventListener('keydown', function (event) {
      var tag = (event.target && event.target.tagName) || '';
      if (event.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        input.focus();
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
