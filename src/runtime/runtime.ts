import {Index, ListIndex, HashIndex} from "./indexes";

//------------------------------------------------------------------------
// Debugging
//------------------------------------------------------------------------

export function printField(field:ScanField) {
  if(isRegister(field)) return "[" + field.offset + "]";
  if(field === undefined || field === null) return field;
  return GlobalInterner.reverse(field);
}

export function printPrefix(prefix:ID[]) {
  return prefix.map((v) => GlobalInterner.reverse(v));
}

export function printScan(constraint:Scan) {
  return `Scan: ${printField(constraint.e)} ${printField(constraint.a)} ${printField(constraint.v)} ${printField(constraint.n)}`;
}

export function printFunction(constraint:FunctionConstraint) {
  return `Function ${constraint.name} ${constraint.fieldNames.map((v) => v + ": " + printField(constraint.fields[v]))}`;
}

export function printConstraint(constraint:Constraint) {
  if(constraint instanceof Scan) {
    return printScan(constraint);
  } else if(constraint instanceof FunctionConstraint) {
    return printFunction(constraint);
  }
}

//------------------------------------------------------------------------
// Runtime
//------------------------------------------------------------------------

export var ALLOCATION_COUNT:any = {};

export function createHash(place = "unknown-hash") {
  if(!ALLOCATION_COUNT[place]) ALLOCATION_COUNT[place] = 0;
  ALLOCATION_COUNT[place]++;
  return Object.create(null);
}

export function createArray(place = "unknown") {
  if(!ALLOCATION_COUNT[place]) ALLOCATION_COUNT[place] = 0;
  ALLOCATION_COUNT[place]++;
  return [];
}

export function copyArray(arr:any[], place = "unknown") {
  if(!ALLOCATION_COUNT[place]) ALLOCATION_COUNT[place] = 0;
  ALLOCATION_COUNT[place]++;
  return arr.slice();
}

export function moveArray(arr:any[], arr2:any[]) {
  let ix = 0;
  for(let elem of arr) {
    arr2[ix] = arr[ix];
  }
  if(arr2.length !== arr.length) arr2.length = arr.length;
  return arr2;
}

function isNumber(thing:any): thing is number {
  return typeof thing === "number";
}

//------------------------------------------------------------------------
// Iterator
//------------------------------------------------------------------------

class Iterator<T> {
  array:T[] = [];
  length:number = 0;
  ix:number = 0;

  push(value:T) {
    this.array[this.length++] = value;
  }

  clear() {
    this.length = 0;
    this.reset();
  }

  reset() {
    this.ix = 0;
  }

  next():T|undefined {
    if(this.ix < this.length) return this.array[this.ix++];
    return;
  }
}

//------------------------------------------------------------------------
// Interning
//------------------------------------------------------------------------

/** The union of value types we support in Eve. */
export type RawValue = string|number;
/**  An interned value's ID. */
export type ID = number;

export class Interner {
  strings: {[value:string]: ID|undefined} = createHash();
  numbers: {[value:number]: ID|undefined} = createHash();
  IDs: RawValue[] = createArray();
  IDRefCount: number[] = createArray();
  IDFreeList: number[] = createArray();
  ix: number = 0;
  arenas: {[arena:string]: Iterator<ID>} = createHash();

  constructor() {
    this.arenas["functionOutput"] = new Iterator<ID>();
  }

  _getFreeID() {
    return this.IDFreeList.pop() || this.ix++;
  }

  reference(id:ID) {
    this.IDRefCount[id]++;
  }

  intern(value: RawValue): ID {
    let coll;
    if(isNumber(value)) {
      coll = this.numbers;
    } else {
      coll = this.strings;
    }
    let found = coll[value];
    if(found === undefined) {
      found = this._getFreeID();
      coll[value] = found;
      this.IDs[found] = value;
      this.IDRefCount[found] = 1;
    } else {
      this.IDRefCount[found]++;
    }
    return found;
  }

  get(value: RawValue): ID|undefined {
    let coll;
    if(isNumber(value)) {
      coll = this.numbers;
    } else {
      coll = this.strings;
    }
    return coll[value];
  }

  reverse(id: ID): RawValue {
    return this.IDs[id];
  }

  release(id: ID|undefined) {
    if(id === undefined) return;

    this.IDRefCount[id]--;
    if(!this.IDRefCount[id]) {
      let value = this.IDs[id];
      let coll;
      if(isNumber(value)) {
        coll = this.numbers;
      } else {
        coll = this.strings;
      }
      coll[value] = undefined;
      this.IDs[id] = undefined as any;
      this.IDFreeList.push(id);
    }
  }

  arenaIntern(arenaName:string, value:RawValue):ID {
    let arena = this.arenas[arenaName];
    if(!arena) {
      arena = this.arenas[arenaName] = new Iterator<ID>();
    }
    // @NOTE: for performance reasons it might make more sense to prevent duplicates
    // from ending up in the list. If that's the case, we could either keep a seen
    // hash or do a get and only intern if it hasn't been seen. This is (probably?)
    // a pretty big performance gain in the case where a bunch of rows might repeat
    // the same function output over and over.
    let id = this.intern(value);
    arena.push(id);
    return id;
  }

  releaseArena(arenaName:string) {
    let arena = this.arenas[arenaName];
    if(!arena) {
      console.warn("Trying to release unknown arena: " + arenaName)
      return;
    }

    let id;
    while((id = arena.next()) !== undefined) {
      this.release(id);
    }
    arena.clear();
  }
}

export var GlobalInterner = new Interner();

//------------------------------------------------------------------------
// EAVNs
//------------------------------------------------------------------------

export type EAVNField = "e"|"a"|"v"|"n";

/**
 * An EAVN is a single Attribute:Value pair of an Entity (a record),
 * produced by a given Node.
 * E.g., the record `[#person name: "josh"]` translates to two EAVNs:
 * (<1>, "tag", "person", <node id>),
 * (<1>, "name", "josh", <node id>)
 */

export class EAVN {
  constructor(public e:ID, public a:ID, public v:ID, public n:ID) {}
};

//------------------------------------------------------------------------
// Changes
//------------------------------------------------------------------------

type Multiplicity = number;

/**
 * A change is an expanded variant of an EAVN, which also tracks the
 * transaction, round, and count of the fact.  These additional fields
 * are used by the executor and index to provide an incremental view
 * of the DB.
 */

export class Change {
  constructor(public e: ID, public a: ID, public v: ID, public n: ID, public transaction:number, public round:number, public count:Multiplicity) {}

  static fromValues(e: any, a: any, v: any, n: any, transaction: number, round: number, count:Multiplicity) {
    return new Change(GlobalInterner.intern(e), GlobalInterner.intern(a), GlobalInterner.intern(v),
                      GlobalInterner.intern(n), transaction, round, count);
  }

  toString() {
    return `Change(${GlobalInterner.reverse(this.e)}, ${GlobalInterner.reverse(this.a)}, ${GlobalInterner.reverse(this.v)}, ${GlobalInterner.reverse(this.n)}, ${this.transaction}, ${this.round}, ${this.count})`;
  }

  equal(other:Change, withoutNode?:boolean, withoutE?:boolean) {
   return (withoutE || this.e == other.e) &&
          this.a == other.a &&
          this.v == other.v &&
          (withoutNode || this.n == other.n) &&
          this.transaction == other.transaction &&
          this.round == other.round &&
          this.count == other.count;
  }

  reverse(interner:Interner = GlobalInterner) {
    let {e, a, v, n, transaction, round, count} = this;
    return new RawChange(interner.reverse(e), interner.reverse(a), interner.reverse(v), interner.reverse(n), transaction, round, count);
  }
}

/** A change with all attributes un-interned. */
export class RawChange {
  constructor(public e: RawValue, public a: RawValue, public v: RawValue, public n: RawValue,
              public transaction:number, public round:number, public count:Multiplicity) {}

  toString() {
    let {e, a, v, n, transaction, round, count} = this;
    return `RawChange(${e}, ${a}, ${v}, ${n}, ${transaction}, ${round}, ${count})`;
  }
}

/** A changeset is a list of changes, intended to occur in a single transaction. */
type ChangeSet = Change[];

//------------------------------------------------------------------------
// Constraints
//------------------------------------------------------------------------

export type NTRCArray = number[];

enum ApplyInputState {
  pass,
  fail,
  none,
}

export interface Constraint {
  isInput:boolean;
  setup():void;
  getRegisters():Register[];
  applyInput(input:Change, prefix:ID[]):ApplyInputState;
  propose(index:Index, prefix:ID[], transaction:number, round:number, results:any[]):Proposal;
  resolveProposal(index:Index, prefix:ID[], proposal:Proposal, transaction:number, round:number, results:any[]):ID[][];
  accept(index:Index, prefix:ID[], transaction:number, round:number, solvingFor:Register[]):boolean;
  acceptInput(index:Index, input:Change, prefix:ID[], transaction:number, round:number):boolean;
  getDiffs(index:Index, prefix:ID[]):NTRCArray;
}

//------------------------------------------------------------------------
// Scans
//------------------------------------------------------------------------

/**
 * A scan maps a set of bound variables to unbound variables.
 */

export class Scan implements Constraint {
  constructor(public e:ScanField,
              public a:ScanField,
              public v:ScanField,
              public n:ScanField) {}

  protected resolved:ResolvedEAVN = {e: undefined, a: undefined, v:undefined, n: undefined};
  protected registers:Register[] = createArray();
  protected registerLookup:boolean[] = createArray();

  isInput:boolean = false;
  proposal:Proposal = {cardinality: 0, forFields: new Iterator<EAVNField>(), forRegisters: new Iterator<Register>(), proposer: this};

  /**
   * Resolve each scan field.
   * The resolved object may contain one of three possible value types:
   * - IGNORE_REG -- this field is entirely ignored by the scan.
   * - undefined -- this field is a register that hasn't been filled in yet.
   *                We'll fill it if possible.
   * - ID -- this field contains a static or already solved value.
   */
  resolve(prefix:ID[]) {
    let resolved = this.resolved;
    if(isRegister(this.e)) {
      resolved.e = prefix[this.e.offset];
    } else {
      resolved.e = this.e;
    }

    if(isRegister(this.a)) {
      resolved.a = prefix[this.a.offset];
    } else {
      resolved.a = this.a;
    }

    if(isRegister(this.v)) {
      resolved.v = prefix[this.v.offset];
    } else {
      resolved.v = this.v;
    }

    if(isRegister(this.n)) {
      resolved.n = prefix[this.n.offset];
    } else {
      resolved.n = this.n;
    }

    return resolved;
  }

  /**
   * A field is unresolved if it is completely ignored by the scan or
   * is an output of the scan.
   */
  fieldUnresolved(resolved:ResolvedEAVN, key: keyof ResolvedEAVN) {
    return resolved[key] === IGNORE_REG || resolved[key] === undefined;
  }

  /**
   * A field is not a static match if it is ignored, not a static
   * field, or the input value does not match the static value.
   */
  notStaticMatch(input:Change, key: "e"|"a"|"v"|"n") {
    return this[key] !== IGNORE_REG && !isRegister(this[key]) && this[key] !== input[key];
  }

  /**
   * Apply new changes that may affect this scan to the prefix to
   * derive only the results affected by this change.  If the change
   * was successfully applied or irrelevant we'll return true. If the
   * change was relevant but invalid (i.e., this scan could not be
   * satisfied due to proposals from previous scans) we'll return
   * false.
   */
  applyInput(input:Change, prefix:ID[]) {
    // If this change isn't relevant to this scan, skip it.
    if(this.notStaticMatch(input, "e")) return ApplyInputState.none;
    if(this.notStaticMatch(input, "a")) return ApplyInputState.none;
    if(this.notStaticMatch(input, "v")) return ApplyInputState.none;
    if(this.notStaticMatch(input, "n")) return ApplyInputState.none;

    // For each register field of this scan:
    //   if the required value is impossible fail,
    //   else add this new value to the appropriate prefix register.
    // @NOTE: Technically, we republish existing values here too.
    //   In practice, that's harmless and eliminates the need for a branch.
    if(isRegister(this.e)) {
      if(prefix[this.e.offset] !== undefined && prefix[this.e.offset] !== input.e) return ApplyInputState.fail;
      prefix[this.e.offset] = input.e;
    }

    if(isRegister(this.a)) {
      if(prefix[this.a.offset] !== undefined && prefix[this.a.offset] !== input.a) return ApplyInputState.fail;
      prefix[this.a.offset] = input.a;
    }

    if(isRegister(this.v)) {
      if(prefix[this.v.offset] !== undefined && prefix[this.v.offset] !== input.v) return ApplyInputState.fail;
      prefix[this.v.offset] = input.v;
    }

    if(isRegister(this.n)) {
      if(prefix[this.n.offset] !== undefined && prefix[this.n.offset] !== input.n) return ApplyInputState.fail;
      prefix[this.n.offset] = input.n;
    }

    return ApplyInputState.pass;
  }

  propose(index:Index, prefix:ID[], transaction:number, round:number, results:any[]):Proposal {
    let {e,a,v,n} = this.resolve(prefix);
    this.proposal.skip = false;
    let proposal = index.propose(this.proposal, e, a, v, n, transaction, round);
    let {forRegisters, forFields} = proposal;

    forRegisters.clear();
    let field;
    while((field = forFields.next()) !== undefined) {
      forRegisters.push(this[field as EAVNField] as Register);
    }
    if(proposal.forFields.length === 0) proposal.skip = true;
    return proposal;
  }

  resolveProposal(index:Index, prefix:ID[], proposal:Proposal, transaction:number, round:number, results:any[]):ID[][] {
    return index.resolveProposal(proposal);
  }

  accept(index:Index, prefix:ID[], transaction:number, round:number, solvingFor:Register[]):boolean {
    // Before we start trying to accept, we check if we care about the
    // registers we are currently solving.
    let solving = false;
    for(let register of solvingFor) {
      if(this.registerLookup[register.offset]) {
        solving = true;
        break;
      }
    }
    // If we aren't looking at any of these registers, then we just
    // say we accept.
    if(!solving) return true;
    let {e,a,v,n} = this.resolve(prefix);
    return index.check(e, a, v, n, transaction, round);
  }

  acceptInput(index:Index, input:Change, prefix:ID[], transaction:number, round:number):boolean {
    let {e,a,v,n} = this.resolve(prefix);
    if((e === IGNORE_REG || input.e === e) &&
       (a === IGNORE_REG || input.a === a) &&
       (v === IGNORE_REG || input.v === v) &&
       (n === IGNORE_REG || input.n === n)) {
      return true;
    } else  {
      return this.accept(index, prefix, transaction, round, this.registers);
    }
  }


  // We precompute the registers we're interested in for fast accepts.
  setup() {
    if(isRegister(this.e)) this.registers.push(this.e);
    if(isRegister(this.a)) this.registers.push(this.a);
    if(isRegister(this.v)) this.registers.push(this.v);
    if(isRegister(this.n)) this.registers.push(this.n);
    for(let register of this.registers) {
      this.registerLookup[register.offset] = true;
    }
  }

  getRegisters():Register[] {
    return this.registers;
  }

  getDiffs(index:Index, prefix:ID[]):NTRCArray {
    let {e,a,v,n} = this.resolve(prefix);
    return index.getDiffs(e,a,v,n);
  }

}

//------------------------------------------------------------------------
// Function constraint
//------------------------------------------------------------------------

type ConstraintFieldMap = {[name:string]: ScanField};
type ResolvedFields = {[fieldName:string]: ResolvedValue};

export class FunctionConstraint implements Constraint {
  static registered: {[name:string]: typeof FunctionConstraint} = {};
  static register(name:string, klass: typeof FunctionConstraint) {
    FunctionConstraint.registered[name] = klass;
  }

  static filter = false;
  static variadic = false;
  static fetchInfo(name:string):typeof FunctionConstraint {
    return FunctionConstraint.registered[name];
  }

  static create(name:string, fields:ConstraintFieldMap, restFields:(ID|Register)[] = createArray()):FunctionConstraint|undefined {
    let cur = FunctionConstraint.registered[name];
    if(!cur) {
      throw new Error(`No function named ${name} is registered.`);
    }

    if(restFields.length && !cur.variadic) {
      console.error(`The ${name} function is not variadic, so may not accept restFields.`);
      restFields = createArray();
    }

    let created = new cur(fields, restFields);
    return created;
  }

  constructor(public fields:ConstraintFieldMap, public restFields:(ID|Register)[]) {}

  name:string;
  args:{[name:string]: string};
  returns:{[name:string]: string};
  argNames:string[];
  returnNames:string[];
  apply: (... things: any[]) => undefined|(number|string)[]; // @FIXME: Not supporting multi-return yet.
  estimate?:(index:Index, prefix:ID[], transaction:number, round:number) => number
  isInput:boolean = false;

  fieldNames:string[];
  proposal:Proposal = {cardinality:0, forFields: new Iterator<EAVNField>(), forRegisters: new Iterator<Register>(), proposer: this};
  protected resolved:ResolvedFields = {};
  protected resolvedRest:(number|undefined)[] = createArray();
  protected registers:Register[] = createArray();
  protected registerLookup:boolean[] = createArray();
  protected applyInputs:(RawValue|RawValue[])[] = createArray();
  protected applyRestInputs:RawValue[] = createArray();

  // We precompute the registers we're interested in for fast accepts.
  setup() {
    this.fieldNames = Object.keys(this.fields);

    for(let fieldName of this.fieldNames) {
      let field = this.fields[fieldName];
      if(isRegister(field)) this.registers.push(field);
    }

    for(let field of this.restFields) {
      if(isRegister(field)) this.registers.push(field);
    }

    for(let register of this.registers) {
      this.registerLookup[register.offset] = true;
    }
  }

  getRegisters() {
    return this.registers;
  }

  /**
   * Similar to `Scan.resolve`, but resolving a map of the function's
   * fields rather than an EAVN.
   */
  resolve(prefix:ID[]) {
    let resolved = this.resolved;

    for(let fieldName of this.fieldNames) {
      let field = this.fields[fieldName];
      if(isRegister(field)) {
        resolved[fieldName] = prefix[field.offset];
      } else {
        resolved[fieldName] = field;
      }
    }

    return resolved;
  }

  /**
   * If a function is variadic, we need to resolve its rest fields as well.
   */
  resolveRest(prefix:ID[]) {
    let resolvedRest = this.resolvedRest;

    let ix = 0;
    for(let field of this.restFields) {
      if(isRegister(field)) {
        resolvedRest[ix] = prefix[field.offset];
      } else {
        resolvedRest[ix] = field;
      }
      ix++;
    }

    return resolvedRest;
  }

  // Function constraints have nothing to apply to the input, so they
  // always return ApplyInputState.none
  applyInput(input:Change, prefix:ID[]):ApplyInputState { return ApplyInputState.none; }

  propose(index:Index, prefix:ID[], transaction:number, round:number, results:any[]):Proposal {
    let proposal = this.proposal;
    proposal.forRegisters.clear();
    let resolved = this.resolve(prefix);

    // If none of our returns are unbound
    // @NOTE: We don't need to worry about the filter case here, since he'll be
    let unresolvedOutput = false;
    for(let output of this.returnNames) {
      if(resolved[output] === undefined) {
        unresolvedOutput = true;
        let field = this.fields[output];
        if(isRegister(field)) {
          proposal.forRegisters.push(field);
        }
      }
    }
    if(!unresolvedOutput) {
      proposal.skip = true;
      return proposal;
    }

    // If any of our args aren't resolved yet, we can't compute results either.
    // @NOTE: This'll need to be touched up when we add optional support if they
    //   co-inhabit the args object.
    for(let input of this.argNames) {
      if(resolved[input] === undefined) {
        proposal.skip = true;
        return proposal;
      }
    }

    // Similarly, if we're variadic we need to check that all of our
    // variadic inputs bound to registers are resolved too.
    // @NOTE: We really need to bend over backwards at the moment to
    //   convince TS to check a static member of the current class...
    if((this.constructor as (typeof FunctionConstraint)).variadic) {
      let resolvedRest = this.resolveRest(prefix);
      for(let field of resolvedRest) {
        if(field === undefined) {
          proposal.skip = true;
          return proposal;
        }
      }
    }

    // Otherwise, we're ready to propose.
    proposal.skip = false;

    if(this.estimate) {
      // If the function provides a cardinality estimator, invoke that.
      proposal.cardinality = this.estimate(index, prefix, transaction, round);

    } else {
      // Otherwise, we'll just return 1 for now, since computing a
      // function is almost always cheaper than a scan.
      // @NOTE: If this is an issue, we can just behave like scans and
      //   compute ourselves here, caching the results.
      proposal.cardinality = 1;
    }

    return proposal;
  }

  /**
   * Pack the resolved register values for the functions argument
   * fields into an array.
   */
  packInputs(prefix:ID[]) {
    let resolved = this.resolve(prefix);
    let inputs = this.applyInputs;
    let argIx = 0;
    for(let argName of this.argNames) {
      // If we're asked to resolve the propoal we know that we've
      // proposed, and we'll only propose if these are resolved.
      inputs[argIx] = GlobalInterner.reverse(resolved[argName]!);
      argIx++;
    }

    // If we're variadic, we also need to pack our var-args up and
    // attach them as the last argument.
    if((this.constructor as (typeof FunctionConstraint)).variadic) {
      let resolvedRest = this.resolveRest(prefix);
      let restInputs = this.applyRestInputs;
      restInputs.length = 0;
      let ix = 0;
      for(let value of resolvedRest) {
        if(value !== undefined) {
          restInputs[ix] = GlobalInterner.reverse(value);
        }
        ix++;
      }

      inputs[argIx] = restInputs;
    }
    return inputs;
  }

  unpackOutputs(outputs:undefined|RawValue[]) {
    if(!outputs) return;
    for(let ix = 0; ix < outputs.length; ix++) {
      outputs[ix] = GlobalInterner.arenaIntern("functionOutput", outputs[ix]);
    }
    return outputs as ID[];
  }

  resolveProposal(index:Index, prefix:ID[], proposal:Proposal, transaction:number, round:number, results:any[]):ID[][] {
    // First we build the args array to provide the apply function.
    let inputs = this.packInputs(prefix);

    // Then we actually apply it and then unpack the outputs.
    // @FIXME: We don't have any intelligent support for not computing unnecessary returns atm.
    // @FIXME: We only support single-return atm.
    let outputs = this.unpackOutputs(this.apply.apply(this, inputs));
    if(!outputs) return results;

    // Finally, if we had results, we create the result prefixes and pass them along.
    let result = createArray("functionResult") as ID[];

    let ix = 0;
    for(let returnName of this.returnNames) {
      let field = this.fields[returnName];
      if(isRegister(field) && !prefix[field.offset]) {
        result[ix] = outputs[ix];
      }
      ix++;
    }
    results.push(result);

    return results;
  }

  accept(index:Index, prefix:ID[], transaction:number, round:number, solvingFor:Register[]):boolean {
    // If none of the registers we're solving for intersect our inputs
    // or outputs, we're not relevant to the solution.
    let isRelevant = false;
    for(let register of solvingFor) {
      if(this.registerLookup[register.offset]) {
        isRelevant = true;
        break;
      }
    }
    if(!isRelevant) return true;

    // If we're missing a field, we can't verify our output yet so we preliminarily accept.
    for(let fieldName of this.fieldNames) {
      let field = this.fields[fieldName];
      if(isRegister(field) && prefix[field.offset] === undefined) return true;
    }

    // First we build the args array to provide the apply function.
    let inputs = this.packInputs(prefix);

    // Then we actually apply it and then unpack the outputs.
    // @FIXME: We don't have any intelligent support for not computing unnecessary returns atm.
    // @FIXME: We only support single-return atm.
    let outputs = this.unpackOutputs(this.apply.apply(this, inputs));
    if(!outputs) {
      return false;
    }

    // Finally, we make sure every return register matches up with our outputs.
    // @NOTE: If we just use solvingFor then we don't know the offsets into the outputs array,
    // so we check everything...
    let ix = 0;
    for(let returnName of this.returnNames) {
      let field = this.fields[returnName];
      if(isRegister(field) && prefix[field.offset]) {
        if(prefix[field.offset] !== outputs[ix]) {
          return false;
        }
      }
      ix++;
    }

    return true;
  }

  acceptInput(index:Index, input:Change, prefix:ID[], transaction:number, round:number):boolean {
    return this.accept(index, prefix, transaction, round, this.registers);
  }

  getDiffs(index:Index, prefix:ID[]):NTRCArray {
    return [];
  }
}

interface FunctionSetup {
  name:string,
  variadic?: boolean,
  args:{[argName:string]: string},
  returns:{[argName:string]: string},
  apply:(... things: any[]) => undefined|(number|string)[],
  estimate?:(index:Index, prefix:ID[], transaction:number, round:number) => number
}

function makeFunction({name, variadic = false, args, returns, apply, estimate}:FunctionSetup) {
  class NewFunctionConstraint extends FunctionConstraint {
    static variadic = variadic;
    static filter = Object.keys(returns).length === 0;
    name = name;
    args = args;
    returns = returns;
    argNames = Object.keys(args);
    returnNames = Object.keys(returns);
    apply = apply;
  }
  FunctionConstraint.register(name, NewFunctionConstraint);
}


makeFunction({
  name: "compare/>",
  args: {a: "number", b: "number"},
  returns: {},
  apply: (a:number, b:number) => {
    return (a > b) ? [] : undefined;
  }
});

makeFunction({
  name: "compare/==",
  args: {a: "number", b: "number"},
  returns: {},
  apply: (a:number, b:number) => {
    return (a === b) ? [] : undefined;
  }
});

makeFunction({
  name: "math/+",
  args: {a: "number", b: "number"},
  returns: {result: "number"},
  apply: (a:number, b:number) => {
    return [a + b];
  }
});

makeFunction({
  name: "eve/internal/gen-id",
  args: {},
  variadic: true,
  returns: {result: "string"},
  apply: (values:RawValue[]) => {
    // @FIXME: This is going to be busted in subtle cases.
    //   If a record exists with a "1" and 1 value for the same
    //   attribute, they'll collapse for gen-id, but won't join
    //   elsewhere.  This means aggregate cardinality will disagree with
    //   action node cardinality.
    return [values.join("|")];
  }
});

makeFunction({
  name: "eve/internal/concat",
  args: {},
  variadic: true,
  returns: {result: "string"},
  apply: (values:RawValue[]) => {
    return [values.join("")];
  }
});

//------------------------------------------------------------------------
// Proposal
//------------------------------------------------------------------------

export interface Proposal {
  cardinality:number,
  forFields:Iterator<EAVNField>,
  forRegisters:Iterator<Register>,
  proposer:Constraint,
  skip?:boolean,
  info?:any,
}

//------------------------------------------------------------------------
// Registers
//------------------------------------------------------------------------

/**
 * A register is just a numerical offset into the solved prefix.
 * We can't make this a type alias because we wouldn't be able to
 * tell the difference between static numbers and registers in scans.
 */

export class Register {
  constructor(public offset:number) {}
}

export function isRegister(x: any): x is Register {
  return x && x.constructor === Register;
}

/** The ignore register is a sentinel value for ScanFields that tell the scan to completely ignore that field. */
export var IGNORE_REG = null;
type IgnoreRegister = typeof IGNORE_REG;

/** A scan field may contain a register, a static interned value, or the IGNORE_REG sentinel value. */
type ScanField = Register|ID|IgnoreRegister;
/** A resolved value is a scan field that, if it contained a register, now contains the register's resolved value. */
export type ResolvedValue = ID|undefined|IgnoreRegister;

type ResolvedEAVN = {e:ResolvedValue, a:ResolvedValue, v:ResolvedValue, n:ResolvedValue};


//------------------------------------------------------------------------
// Nodes
//------------------------------------------------------------------------

/**
 * Base class for nodes, the building blocks of blocks.
 */
export interface Node {
  /**
   * Evaluate the node in the context of the currently solved prefix,
   * returning a set of valid prefixes to continue the query as
   * results.
   */
  exec(index:Index, input:Change, prefix:ID[], transaction:number, round:number, results:Iterator<ID[]>, changes:Transaction):boolean;
}

/**
 * The JoinNode implements generic join across multiple constraints.
 * Since our system is incremental, we need to do something slightly
 * fancier than we did in the previous runtime.  For each new change
 * that enters the system, we ask each of our constraints whether they
 * are capable of producing a new result. In the case where a single
 * constraint can, we presolve that constraint and then run the rest
 * normally, limited to only producing results that match the first
 * constraint. However, if multiple constraints might apply the input,
 * we need to run for each *combination* of heads. E.g.:
 *
 * Given a join node with constraints [A, B, C, and D], where A and D
 * can both apply the input, we must combine the results of the
 * following computations to get the full result set:
 *
 * Apply {A} -> Do {B, C, D}
 * Apply {A, D} -> Do {B, C}
 * Apply {D} -> Do {A, B, C}
 *
 * We calculate this using the power set in exec.
 *
 * We then apply each of these combinations by running a genericJoin
 * over the remaining unresolved registers.  We ask each un-applied
 * constraint to propose a register to be solved. If a constraint is
 * capable of resolving one, it returns the set of registers it can
 * resolve and an estimate of the result set's cardinality. Generic
 * Join chooses the cheapest proposal, which the winning constraint
 * then fully computes (or retrieves from cache and returns). Next it
 * asks each other constraint to accept or reject the proposal. If the
 * constraint doesn't apply to the solved registers, it accepts.  If
 * the solution contains results that match the output of the
 * constraint, it also accepts. Otherwise, it must reject the solution
 * and that particular run yields no results.
 */

export class JoinNode implements Node {
  registerLength = 0;
  registerArrays:Register[][];
  proposedResultsArrays:ID[][];
  emptyProposal:Proposal = {cardinality: Infinity, forFields: new Iterator<EAVNField>(), forRegisters: new Iterator<Register>(), skip: true, proposer: {} as Constraint};
  inputState = {constraintIx: 0, state: ApplyInputState.none};
  protected affectedConstraints = new Iterator<Constraint>();

  constructor(public constraints:Constraint[]) {
    // We need to find all the registers contained in our scans so that
    // we know how many rounds of Generic Join we need to do.
    let registers = createArray() as Register[][];
    let proposedResultsArrays = createArray() as ID[][];
    for(let constraint of constraints) {
      constraint.setup();
      for(let register of constraint.getRegisters()) {
        registers[register.offset] = createArray() as Register[];
        proposedResultsArrays[register.offset] = createArray() as ID[];
      }
    }
    this.registerArrays = registers;
    this.registerLength = registers.length;
    this.proposedResultsArrays = proposedResultsArrays;
  }

  findAffectedConstraints(input:Change, prefix:ID[]):Iterator<Constraint> {
    // @TODO: Hoist me out.
    let affectedConstraints = this.affectedConstraints;
    affectedConstraints.clear();
    for(let ix = 0, len = this.constraints.length; ix < len; ix++) {
      let constraint = this.constraints[ix];
      let result = constraint.applyInput(input, prefix);

      if(result !== ApplyInputState.none) {
        affectedConstraints.push(constraint);
      }
    }

    return affectedConstraints;
  }

  applyCombination(index:Index, input:Change, prefix:ID[], transaction:number, round:number, results:Iterator<ID[]>) {
    let countOfSolved = 0;
    for(let field of prefix) {
      if(field !== undefined) countOfSolved++;
    }
    let remainingToSolve = this.registerLength - countOfSolved;
    let valid = this.presolveCheck(index, input, prefix, transaction, round);
    if(!valid) {
      // do nothing
      return false;

    } else if(!remainingToSolve) {
      // if it is valid and there's nothing left to solve, then we've found
      // a full result and we should just continue
      prefix.push(round, 1);
      results.push(copyArray(prefix, "results"));
      prefix.pop();
      prefix.pop();
      return true;

    } else {
      // For each node, find the new results that match the prefix.
      this.genericJoin(index, prefix, transaction, round, results, remainingToSolve);
      return true;
    }
  }

  unapplyConstraint(constraint:Constraint, prefix:ID[]) {
    for(let register of constraint.getRegisters()) {
      prefix[register.offset] = undefined as any;
    }
  }

  presolveCheck(index:Index, input:Change, prefix:ID[], transaction:number, round:number):boolean {
    let {constraints} = this;

    for(let constraint of constraints) {
      let valid = constraint.acceptInput(index, input, prefix, transaction, round);
      if(!valid) {
        return false;
      }
    }

    return true;
  }

  computeMultiplicities(results:Iterator<ID[]>, prefix:ID[], currentRound:number, diffs: NTRCArray[], diffIndex:number = -1) {
    if(diffIndex === -1) {
      prefix.push(currentRound, 1)
      this.computeMultiplicities(results, prefix, currentRound, diffs, diffIndex + 1);
      prefix.pop();
      prefix.pop();
    } else if(diffIndex === diffs.length) {
      results.push(copyArray(prefix, "gjResultsArray"));
    } else {
      let ntrcs = diffs[diffIndex];
      let roundToMultiplicity:{[round:number]: number} = {};
      for(let ix = 0; ix < ntrcs.length; ix += 4) {
        // n = ix, t = ix + 1, r = ix + 2, c = ix + 3
        let round = ntrcs[ix + 2];
        let count = ntrcs[ix + 3];
        let v = roundToMultiplicity[round] || 0;
        roundToMultiplicity[round] = v + count;
      }
      for(let roundString in roundToMultiplicity) {
        let round = +roundString;
        let count = roundToMultiplicity[round];
        if(count === 0) continue;
        let startingRound = prefix[prefix.length - 2];
        let startingMultiplicity = prefix[prefix.length - 1];
        prefix[prefix.length - 2] = Math.max(startingRound, round);
        prefix[prefix.length - 1] = startingMultiplicity * count;
        this.computeMultiplicities(results, prefix, currentRound, diffs, diffIndex + 1);
        prefix[prefix.length - 2] = startingRound;
        prefix[prefix.length - 1] = startingMultiplicity;
      }
    }
    return results;
  }

  genericJoin(index:Index, prefix:ID[], transaction:number, round:number, results:Iterator<ID[]>, roundIx:number = this.registerLength):Iterator<ID[]> {
    let {constraints, emptyProposal} = this;
    let proposedResults = this.proposedResultsArrays[roundIx - 1];
    let forRegisters:Register[] = this.registerArrays[roundIx - 1];
    proposedResults.length = 0;

    let bestProposal:Proposal = emptyProposal;

    for(let constraint of constraints) {
      let current = constraint.propose(index, prefix, transaction, round, proposedResults);
      if(!current.skip && current.cardinality === 0) {
        return results;
      } else if(current.cardinality < bestProposal.cardinality && !current.skip) {
        bestProposal = current;
      }
    }

    if(bestProposal.skip) {
      return results;
    }


    let {proposer} = bestProposal;
    // We have to copy here because we need to keep a reference to this even if later
    // rounds might overwrite the proposal
    moveArray(bestProposal.forRegisters.array, forRegisters);
    let resolved:any[] = proposer.resolveProposal(index, prefix, bestProposal, transaction, round, proposedResults);
    if(resolved[0].constructor === Array) {
      resultLoop: for(let result of resolved) {
        let ix = 0;
        for(let register of forRegisters) {
          prefix[register.offset] = result[ix];
          ix++;
        }
        for(let constraint of constraints) {
          if(constraint === proposer) continue;
          if(!constraint.accept(index, prefix, transaction, round, forRegisters)) {
            continue resultLoop;
          }
        }
        if(roundIx === 1) {
          let diffs = [];
          for(let constraint of constraints) {
            if(constraint.isInput || constraint instanceof FunctionConstraint) continue;
            diffs.push(constraint.getDiffs(index, prefix));
          }
          this.computeMultiplicities(results, prefix, round, diffs);
        } else {
          this.genericJoin(index, prefix, transaction, round, results, roundIx - 1);
        }
      }
    } else {
      let register = forRegisters[0];
      resultLoop: for(let result of resolved) {
        prefix[register.offset] = result as ID;
        for(let constraint of constraints) {
          if(constraint === proposer) continue;
          if(!constraint.accept(index, prefix, transaction, round, forRegisters)) {
            continue resultLoop;
          }
        }
        if(roundIx === 1) {
          let diffs = [];
          for(let constraint of constraints) {
            if(constraint.isInput || constraint instanceof FunctionConstraint) continue;
            diffs.push(constraint.getDiffs(index, prefix));
          }
          this.computeMultiplicities(results, prefix, round, diffs);
        } else {
          this.genericJoin(index, prefix, transaction, round, results, roundIx - 1);
        }
      }
    }
    for(let register of forRegisters) {
      // @NOTE: marking this as any is spoopy at best, but since we should never
      // iterate over the prefix, but instead use it almost like a hash, this
      // should be fine.
      prefix[register.offset] = undefined as any;
    }

    return results;
  }

  exec(index:Index, input:Change, prefix:ID[], transaction:number, round:number, results:Iterator<ID[]>):boolean {
    let didSomething = false;
    let affectedConstraints = this.findAffectedConstraints(input, prefix);

    // @FIXME: This is frivolously wasteful.
    for(let constraintIxz = 0; constraintIxz < affectedConstraints.length; constraintIxz++) {
      let constraint = affectedConstraints.array[constraintIxz];
      this.unapplyConstraint(constraint, prefix);
    }

    let combinationCount = Math.pow(2, affectedConstraints.length);
    for(let comboIx = combinationCount - 1; comboIx > 0; comboIx--) {
      //console.log("  Combo:", comboIx);

      for(let constraintIx = 0; constraintIx < affectedConstraints.length; constraintIx++) {
        let mask = 1 << constraintIx;
        let isIncluded = (comboIx & mask) !== 0;
        let constraint = affectedConstraints.array[constraintIx];
        constraint.isInput = isIncluded;

        if(isIncluded) {
          let valid = constraint.applyInput(input, prefix);
          // If any member of the input constraints fails, this whole combination is doomed.
          if(valid === ApplyInputState.fail) break;

          //console.log("    " + printConstraint(constraint));
        } else {
          this.unapplyConstraint(constraint, prefix);
        }
      }

      //console.log("    ", printPrefix(prefix));
      didSomething = this.applyCombination(index, input, prefix, transaction, round, results) || didSomething;
    }

    affectedConstraints.reset();
    let constraint;
    while((constraint = affectedConstraints.next()) !== undefined) {
      constraint.isInput = false;
    }

    return didSomething;
  }

}

export class InsertNode implements Node {
  constructor(public e:ID|Register,
              public a:ID|Register,
              public v:ID|Register,
              public n:ID|Register) {}

  protected resolved:ResolvedEAVN = {e: undefined, a: undefined, v:undefined, n: undefined};

  resolve = Scan.prototype.resolve;

  exec(index:Index, input:Change, prefix:ID[], transactionId:number, round:number, results:Iterator<ID[]>, transaction:Transaction):boolean {
    let {e,a,v,n} = this.resolve(prefix);

    // @FIXME: This is pretty wasteful to copy one by one here.
    results!.push(prefix);

    if(e === undefined || a === undefined || v === undefined || n === undefined) {
      return false;
    }

    let prefixRound = prefix[prefix.length - 2];
    let prefixCount = prefix[prefix.length - 1];

    // @TODO: when we do removes, we could say that if the result is a remove, we want to
    // dereference these ids instead of referencing them. This would allow us to clean up
    // the interned space based on what's "in" the indexes. The only problem is that if you
    // held on to a change, the IDs of that change may no longer be in the interner, or worse
    // they may have been reassigned to something else. For now, we'll just say that once something
    // is in the index, it never goes away.
    GlobalInterner.reference(e!);
    GlobalInterner.reference(a!);
    GlobalInterner.reference(v!);
    GlobalInterner.reference(n!);
    let change = new Change(e!, a!, v!, n!, transactionId, prefixRound + 1, prefixCount * input.count);
    this.output(transaction, change);

    return true;
  }

  output(transaction:Transaction, change:Change) {
    transaction.output(change);
  }
}

export class WatchNode extends InsertNode {

  output(transaction:Transaction, change:Change) {
    transaction.export(change);
  }
}

//------------------------------------------------------------------------------
// BinaryFlow
//------------------------------------------------------------------------------

type KeyFunction = (prefix:ID[]) => string;

class IntermediateIndex {
  static CreateKeyFunction(registers:Register[]):KeyFunction {
    let items = registers.map((reg) => {
      return `prefix[${reg.offset}]`;
    })
    let code = `
      return ${items.join(' + "|" + ')};
      `;
    return new Function("prefix", code) as KeyFunction;
  }

  index:{[key:string]: number[]} = {};

  // @TODO: we should probably consider compacting these times as they're
  // added
  insert(key:string, round:number, count:number) {
    let found = this.index[key];
    if(!found) found = this.index[key] = createArray("IntermediateIndexDiffs");
    found.push(round, count);
  }

  get(key:string) {
    return this.index[key];
  }
}

abstract class BinaryFlow implements Node {
  leftResults = new Iterator<ID[]>();
  rightResults = new Iterator<ID[]>();

  constructor(public left:Node, public right:Node) { }

  exec(index:Index, input:Change, prefix:ID[], transaction:number, round:number, results:Iterator<ID[]>, changes:Transaction):boolean {
    let {left, right, leftResults, rightResults} = this;
    leftResults.clear();
    left.exec(index, input, prefix, transaction, round, leftResults, changes);
    rightResults.clear();
    right.exec(index, input, prefix, transaction, round, rightResults, changes);
    let result;
    while((result = leftResults.next()) !== undefined) {
      this.onLeft(index, result, transaction, round, results);
    }
    while((result = rightResults.next()) !== undefined) {
      this.onRight(index, result, transaction, round, results);
    }
    return true;
  }

  abstract onLeft(index:Index, prefix:ID[], transaction:number, round:number, results:Iterator<ID[]>):void;
  abstract onRight(index:Index, prefix:ID[], transaction:number, round:number, results:Iterator<ID[]>):void;
}

export class AntiJoin extends BinaryFlow {
  leftIndex = new IntermediateIndex();
  rightIndex = new IntermediateIndex();
  keyFunc:KeyFunction;

  constructor(public left:Node, public right:Node, public keyRegisters:Register[]) {
    super(left, right);
    this.keyFunc = IntermediateIndex.CreateKeyFunction(keyRegisters);
  }

  onLeft(index:Index, prefix:ID[], transaction:number, round:number, results:Iterator<ID[]>):void {
    let key = this.keyFunc(prefix);
    let count = prefix[prefix.length - 1];
    this.leftIndex.insert(key, round, count);
    let diffs = this.rightIndex.get(key)
    if(!diffs || !diffs.length) {
      return results.push(prefix);
    }
  }

  onRight(index:Index, prefix:ID[], transaction:number, round:number, results:Iterator<ID[]>):void {
    let key = this.keyFunc(prefix);
    let count = prefix[prefix.length - 1];
    this.rightIndex.insert(key, round, count);
    let diffs = this.leftIndex.get(key)
    if(!diffs) return;
    for(let ix = 0, len = diffs.length; ix < len; ix += 2) {
      let leftRound = diffs[ix];
      let leftCount = diffs[ix + 1];
      let upperBound = Math.max(round, leftRound);
      let result = copyArray(prefix, "AntiJoinResult");
      result[result.length - 2] = upperBound;
      result[result.length - 1] = count * leftCount * -1;
      results.push(result);
    }

  }
}

//------------------------------------------------------------------------------
// Block
//------------------------------------------------------------------------------

export class Block {
  constructor(public name:string, public nodes:Node[]) {}

  // We're going to essentially double-buffer the result arrays so we can avoid allocating in the hotpath.
  results = new Iterator<ID[]>();
  initial:ID[] = createArray();
  protected nextResults = new Iterator<ID[]>();

  exec(index:Index, input:Change, transaction:Transaction):boolean {
    let blockState = ApplyInputState.none;
    this.results.clear();
    this.initial.length = 0;
    this.results.push(this.initial);
    this.nextResults.clear();
    let prefix;
    // We populate the prefix with values from the input change so we only derive the
    // results affected by it.
    for(let node of this.nodes) {
      while((prefix = this.results.next()) !== undefined) {
        let valid = node.exec(index, input, prefix, transaction.transaction, transaction.round, this.nextResults, transaction);
        if(!valid) {
          return false;
        }
      }
      let tmp = this.results;
      this.results = this.nextResults;
      this.nextResults = tmp;
      // @NOTE: We don't really want to shrink this array probably.
      this.nextResults.clear();
    }

    return true;
  }
}

//------------------------------------------------------------------------------
// Transaction
//------------------------------------------------------------------------------

export class Transaction {
  round = 0;
  protected roundChanges:Change[][] = [];
  protected exportedChanges:Change[] = [];
  constructor(public transaction:number, public blocks:Block[], public changes:Change[], protected exportHandler?:ExportHandler) {}

  output(change:Change) {
    // console.log("          <-", change.toString())
    let cur = this.roundChanges[change.round] || createArray("roundChangesArray");
    cur.push(change);
    this.roundChanges[change.round] = cur;
  }

  export(change:Change) {
    this.exportedChanges.push(change);
  }

  protected collapseMultiplicity(changes:Change[], results:Change[] /* output */) {
    // We sort the changes to group all the same EAVs together.
    // @FIXME: This sort comparator is flawed. It can't differentiate certain EAVs, e.g.:
    // A: [1, 2, 3]
    // B: [2, 1, 3]
    changes.sort((a,b) => (a.e - b.e) + (a.a - b.a) + (a.v - b.v));
    let changeIx = 0;
    for(let changeIx = 0; changeIx < changes.length; changeIx++) {
      let current = changes[changeIx];

      // Collapse each subsequent matching EAV's multiplicity into the current one's.
      while(changeIx + 1 < changes.length) {
        let next = changes[changeIx + 1];
        if(next.e == current.e && next.a == current.a && next.v == current.v) {
          current.count += next.count;
          changeIx++;
        } else {
          break;
        }
      }
      // console.log("next round change:", current.toString())
      if(current.count !== 0) results.push(current);
    }

    return results;
  }

  exec(index:Index) {
    let {changes, roundChanges} = this;
    let changeIx = 0;
    // console.log("Blocks: " + this.blocks.map((b) => b.name).join(", "));
    while(changeIx < changes.length) {
      let change = changes[changeIx];
      this.round = change.round;
      // console.log("  Round:", this.round);

      // console.log("    -> " + change);
      if(index.hasImpact(change)) {
        for(let block of this.blocks) {
          // console.log("    ", block.name);
          let start = changes.length;
          block.exec(index, change, this);
          // console.log("");
        }
      }
      if(index.getImpact(change) >= 0) index.insert(change);
      else console.warn("GOT NON-POSITIVE IMPACT: ", change.toString() + "\n");

      changeIx++;
      let next = changes[changeIx];
      let maxRound = roundChanges.length;
      if(!next && this.round < maxRound) {
        for(let ix = this.round + 1; ix < maxRound; ix++) {
          let nextRoundChanges = roundChanges[ix];
          if(nextRoundChanges) {
            let oldLength = changes.length;
            this.collapseMultiplicity(nextRoundChanges, changes);

            // We only want to break to begin the next fixedpoint when we have something new to run.
            if(oldLength < changes.length) break;
          }
        }
      }
    }

    if(this.exportedChanges.length) {
      console.log("Pre:");
      console.log("  " + this.exportedChanges.join("\n  "));


      if(!this.exportHandler) throw new Error("Unable to export changes without export handler.");
      let exports = createArray("exportsArray");
      this.collapseMultiplicity(this.exportedChanges, exports);
      if(exports.length) {
        console.log("Exporting:");
        console.log("  " + exports.join("\n  "));
        this.exportHandler(exports);
      }
    }

    // Once the transaction is effectively done, we need to clean up after ourselves. We
    // arena allocated a bunch of IDs related to function call outputs, which we can now
    // safely release.
    GlobalInterner.releaseArena("functionOutput");
  }
}

//------------------------------------------------------------------------------
// Exporter
//------------------------------------------------------------------------------
interface TagMap<V> {[tag:number]: V};
interface EntityMap<V> {[entityId:number]: V};
interface AttributeMap<V> {[attributeId:number]: V};
interface Record {[attribute:string]: RawValue[]};

type ExportHandler = (changes:Change[]) => void;
export type DiffConsumer = (changes:Readonly<RawChange[]>) => void;

const TAG = GlobalInterner.intern("tag");

export class Exporter {
  protected _diffTriggers:TagMap<DiffConsumer[]> = {};

  triggerOnDiffs(tag:ID, handler:DiffConsumer):void {
    if(!this._diffTriggers[tag]) this._diffTriggers[tag] = createArray();
    if(this._diffTriggers[tag].indexOf(handler) === -1) {
      this._diffTriggers[tag].push(handler);
    }
  }

  handle = (changes:Change[]) => {
    let newByTags:TagMap<ID[]> = {};
    let entityChanges:EntityMap<Change[]> = {};
    for(let change of changes) {
      if(change.a === TAG) {
        if(!newByTags[change.v]) newByTags[change.v] = createArray("exporterNewTags");
        newByTags[change.v].push(change.e);
      }

      if(!entityChanges[change.e]) entityChanges[change.e] = createArray("exporterEntityChanges");
      entityChanges[change.e].push(change);
    }

    // @NOTE: We're leaving a lot of perf on the table right now. It's not a priority atm.
    for(let rawTag of Object.keys(newByTags)) {
      let tag:ID = +rawTag;
      let entityIds = newByTags[tag];
      if(this._diffTriggers[tag]) {
        let output:RawChange[] = createArray("exporterOutput");
        for(let entityId of newByTags[tag]) {
          for(let change of entityChanges[entityId]) {
            // We'll omit the tag you're listening to so it doesn't pollute your diffs.
            if(change.a === TAG && change.v === tag) continue;
            output.push(change.reverse());
          }
        }
        for(let trigger of this._diffTriggers[tag]) {
          trigger(output);
        }
      }
    }
  }
}
