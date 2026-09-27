export function serialize(doc) {
  if (Array.isArray(doc)) return doc.map(serialize);
  if (!doc || typeof doc !== 'object') return doc;
  const out = typeof doc.toJSON === 'function' ? doc.toJSON() : { ...doc };
  if (out._id !== undefined) {
    out.id = String(out._id);
    delete out._id;
  }
  return out;
}

export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
