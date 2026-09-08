const platforms = new Map();

function register(client) {
  const id = String(client?.id || '').trim();
  if (!id) throw new Error('crawler client requires id');
  if (typeof client.search !== 'function' || typeof client.fetchNote !== 'function') {
    throw new Error(`crawler client "${id}" must implement search and fetchNote`);
  }
  platforms.set(id, client);
}

function get(id) {
  const client = platforms.get(String(id || ''));
  if (!client) throw new Error(`Unknown crawler platform: ${id}`);
  return client;
}

function ids() {
  return [...platforms.keys()];
}

register(require('./xhs'));

module.exports = {
  register,
  get,
  ids,
};
