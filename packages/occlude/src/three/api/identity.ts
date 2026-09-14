/** Compact deterministic identity, never an ambient allocation counter. The
 * domain assemblers still reject collisions; this is not a security hash. */
export function identity(domain: string, ...parts: unknown[]): string {
  const text=JSON.stringify(parts);let hash=0xcbf29ce484222325n;
  for(let i=0;i<text.length;i++){
    const code=text.charCodeAt(i);
    hash=BigInt.asUintN(64,(hash^BigInt(code&255))*0x100000001b3n);
    hash=BigInt.asUintN(64,(hash^BigInt(code>>>8))*0x100000001b3n);
  }
  return `${domain}:${hash.toString(16).padStart(16,'0')}`;
}
