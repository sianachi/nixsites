const status = document.getElementById('status');
const list = document.getElementById('servers');
const say = (text) => {
  status.textContent = text;
};
// Rejections arrive as the main process's plain message.
const attempt = (work) => work().catch((error) => say(String(error)));

function render(servers) {
  list.replaceChildren(
    ...servers.map((origin) => {
      const host = new URL(origin).host;
      const item = document.createElement('li');
      const open = document.createElement('button');
      open.className = 'open';
      open.textContent = host;
      open.onclick = () =>
        attempt(async () => {
          say(`Opening ${host}…`);
          await window.nixPicker({ op: 'open', origin });
        });
      const remove = document.createElement('button');
      remove.textContent = '✕';
      remove.setAttribute('aria-label', `Remove ${host}`);
      remove.onclick = () =>
        attempt(async () => {
          render(await window.nixPicker({ op: 'remove', origin }));
          say(`Removed ${host} and its offline copy.`);
        });
      item.append(open, remove);
      return item;
    }),
  );
}

document.getElementById('add').onsubmit = (event) => {
  event.preventDefault();
  void attempt(async () => {
    say('Checking…');
    await window.nixPicker({ op: 'add', address: document.getElementById('address').value });
  });
};

void attempt(async () => {
  render(await window.nixPicker({ op: 'getServers' }));
  const failed = new URLSearchParams(location.search).get('failed');
  if (failed !== null)
    say(
      `Could not open ${failed}. It may be unreachable, and has no offline copy on this computer yet.`,
    );
});
