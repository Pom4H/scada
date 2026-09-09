import { component, registerComponent, type Definition, type Equipment, type Endpoint, type Field, type CommandDefinition } from './core';
import type { EquipmentCommand, Signal } from './runtime/protocol';

type FieldValue<F extends Field> = F extends { choices: readonly (infer V extends string)[] } ? V : F['default'] extends number ? number : F['default'] extends boolean ? boolean : string;
export type ComponentProps<D extends Definition> = { [K in keyof D['fields']]?: FieldValue<D['fields'][K]> };
export type ComponentInstance<D extends Definition> = Equipment & { [K in keyof D['ports']]: Endpoint & { readonly role: D['ports'][K]['role'] } };
export type ComponentSignals<D extends Definition> = D extends { signals: infer S extends NonNullable<Definition['signals']> } ? { [K in keyof S]: Extract<Signal, {type: S[K]['type']}> } : Record<never, never>;
type CommandValue<C> = C extends { choices: readonly (infer V extends string)[] } ? V : C extends { valueType: 'number' } ? number : C extends { valueType: 'boolean' } ? boolean : C extends { valueType: 'string' } ? string : never;
type Commands<D extends Definition> = D extends { commands: infer C extends Record<string, CommandDefinition> } ? C : Record<never, never>;
export interface ComponentFactory<D extends Definition> {
  (id: string, props: ComponentProps<D>): ComponentInstance<D>;
  readonly definition: D;
  command<K extends keyof Commands<D> & string>(equipmentId: string, commandId: string, name: K, ...value: CommandValue<Commands<D>[K]> extends never ? [] : [CommandValue<Commands<D>[K]>]): EquipmentCommand;
}
/** Trusted installed code. Literal metadata supplies editor validation and external IDE types. */
export function defineComponent<const D extends Definition>(kind: string, definition: D): ComponentFactory<D> {
  registerComponent(kind, definition);
  const factory = ((id: string, props: ComponentProps<D>) => component(kind, id, props as Record<string, string | number | boolean>) as ComponentInstance<D>) as ComponentFactory<D>;
  Object.defineProperty(factory, 'definition', { value: definition });
  factory.command = (equipmentId, commandId, name, ...value) => ({ equipmentId, commandId, command: name, ...(value.length ? {value: value[0]} : {}) });
  return factory;
}
