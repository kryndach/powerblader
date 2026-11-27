// Zero-GC Schema-Cached In-Place Snapshotter for jsnes PAPU, Mappers & Pads

function buildSchema(obj, sampleJson) {
  const scalars = [], arrays = [], children = [];
  for (const [k, v] of Object.entries(sampleJson)) {
    const live = obj[k];
    if (Array.isArray(v) || ArrayBuffer.isView(live)) {
      arrays.push({ key: k, len: live?.length ?? v.length });
    } else if (v && typeof v === 'object' && live && typeof live === 'object') {
      children.push({ key: k, schema: buildSchema(live, v) });
    } else {
      scalars.push(k);
    }
  }
  return { scalars, arrays, children };
}

function getSchema(obj) {
  if (!obj) return null;
  if (obj._zgcSchema) return obj._zgcSchema;
  const ctor = obj.constructor;
  const tag = obj._mmc3Regs ? '_mmc3' : '';
  const cacheKey = `_zgcSchemaCache${tag}`;
  if (ctor && ctor[cacheKey]) {
    obj._zgcSchema = ctor[cacheKey];
    return obj._zgcSchema;
  }
  const schema = buildSchema(obj, obj.toJSON());
  obj._zgcSchema = schema;
  if (ctor) ctor[cacheKey] = schema;
  return schema;
}

function allocBuf(schema) {
  return {
    schema,
    scalars: new Array(schema.scalars.length),
    arrays: schema.arrays.map((a) => new Array(a.len)),
    children: schema.children.map((c) => allocBuf(c.schema))
  };
}

function copyInto(obj, buf) {
  const { scalars, arrays, children } = buf.schema;
  for (let i = 0; i < scalars.length; i++) buf.scalars[i] = obj[scalars[i]];
  for (let i = 0; i < arrays.length; i++) {
    const src = obj[arrays[i].key], dst = buf.arrays[i];
    if (!src) continue;
    for (let j = 0; j < dst.length; j++) dst[j] = src[j];
  }
  for (let i = 0; i < children.length; i++) {
    copyInto(obj[children[i].key], buf.children[i]);
  }
}

function restoreFrom(obj, buf) {
  const { scalars, arrays, children } = buf.schema;
  for (let i = 0; i < scalars.length; i++) obj[scalars[i]] = buf.scalars[i];
  for (let i = 0; i < arrays.length; i++) {
    const dst = obj[arrays[i].key], src = buf.arrays[i];
    if (!dst) continue;
    for (let j = 0; j < src.length; j++) dst[j] = src[j];
  }
  for (let i = 0; i < children.length; i++) {
    restoreFrom(obj[children[i].key], buf.children[i]);
  }
}

export function saveObjectZeroGc(obj, slot, fieldKey) {
  if (!obj) { slot[fieldKey] = null; return; }
  const schema = getSchema(obj);
  let buf = slot[fieldKey];
  if (!buf || buf.schema !== schema) {
    buf = allocBuf(schema);
    slot[fieldKey] = buf;
  }
  copyInto(obj, buf);
}

export function restoreObjectZeroGc(obj, slot, fieldKey) {
  const buf = slot[fieldKey];
  if (!obj || !buf) return;
  restoreFrom(obj, buf);
}
