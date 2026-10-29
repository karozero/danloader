import { matchesHost, type ServiceId } from "./contracts.js";
const domains: Readonly<
  Record<Exclude<ServiceId, "generic">, readonly string[]>
> = {
  youtube: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  instagram: ["instagram.com", "facebook.com"],
  boosty: ["boosty.to"],
  kinescope: ["kinescope.io"],
};
export function matchesServiceHost(
  url: URL,
  id: Exclude<ServiceId, "generic">,
): boolean {
  return domains[id].some((domain) => matchesHost(url, domain));
}
export function knownServiceId(value: string): ServiceId {
  try {
    const url = new URL(value);
    return (
      (Object.keys(domains) as Exclude<ServiceId, "generic">[]).find((id) =>
        matchesServiceHost(url, id),
      ) || "generic"
    );
  } catch {
    return "generic";
  }
}
