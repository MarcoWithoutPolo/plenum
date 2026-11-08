/** "1 task", "2 tasks": a count with its noun, singular or plural. */
export function counted(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
