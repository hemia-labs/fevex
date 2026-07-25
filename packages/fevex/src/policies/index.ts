export interface PolicyDefinition {
  name: string;
}

export function definePolicy<T extends PolicyDefinition>(policy: T): T {
  return policy;
}
