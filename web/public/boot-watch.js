/*
 * HARDWARE DOG / THE INTERFACE IS DOWNLOADING
 *
 * diagnostic.html shows its static introduction while the interface
 * downloads. On a slow connection this says so after 8 s; if a file of the
 * interface fails to download (the connection dropped), it says that and
 * offers RELOAD, instead of an introduction that never turns into the
 * tool. Nothing is said once the interface (or its own start failure
 * screen) is on the page. A classic script: it fetches nothing.
 */
(function () {
  var note = null;
  function say(text, reload) {
    var intro = document.getElementById('intro');
    var app = document.getElementById('app');
    if (!intro || (app && app.childElementCount > 0)) return;
    if (!note) {
      note = document.createElement('p');
      note.className = 'boot-watch';
      intro.insertBefore(note, intro.firstChild);
    }
    note.setAttribute('role', reload ? 'alert' : 'status');
    note.textContent = text + ' ';
    if (reload) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'RELOAD';
      b.onclick = function () {
        location.reload();
      };
      note.appendChild(b);
    }
  }
  var slow = setTimeout(function () {
    say('Hardware Dog is still downloading: the connection is slow. After one visit it opens offline.', false);
  }, 8000);
  window.addEventListener(
    'error',
    function (e) {
      var t = e.target;
      if (t && (t.tagName === 'SCRIPT' || (t.tagName === 'LINK' && /preload|stylesheet/.test(t.rel)))) {
        clearTimeout(slow);
        say('A file of the interface could not be downloaded (the connection dropped?). Nothing was lost.', true);
      }
    },
    true,
  );
})();
