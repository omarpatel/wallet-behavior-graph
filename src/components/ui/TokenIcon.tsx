import { Avatar, type AvatarSize } from "./Avatar";

/**
 * Loadable form of a token's metadata image, or null. Metadata is free-form: `ipfs://` URIs go through the public
 * gateway; plain `http://` (mostly bare IPs) would be blocked as mixed content on the https site, so it is dropped.
 */
function tokenIconSrc(icon: string | null | undefined): string | null {
  if (!icon) return null;
  if (icon.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${icon.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
  return icon.startsWith("https://") ? icon : null;
}

/** Token icon over a monogram of the symbol: a missing, unloadable or dead-host image leaves the monogram. */
export function TokenIcon({ icon, symbol, size = 32 }: { icon: string | null | undefined; symbol: string; size?: AvatarSize }) {
  return <Avatar src={tokenIconSrc(icon)} name={symbol} size={size} plain external className="border border-line" />;
}
