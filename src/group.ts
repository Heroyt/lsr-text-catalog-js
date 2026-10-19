/** A catalog group is the root segment of its semantic keys and gettext contexts. */
export function catalogGroup(key: string): string {
  const dot = key.indexOf(".");
  return dot < 0 ? key : key.slice(0, dot);
}
