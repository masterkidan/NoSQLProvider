/**
 * InMemoryProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * ObjectStoreProvider provider setup for a non-persisted in-memory database backing provider.
 */

import {
  attempt,
  isError,
  each,
  includes,
  compact,
  map,
  find,
  values,
  flatten,
  dropRight,
  takeRight,
  drop,
  take,
} from "lodash";
import {
  DbIndexFTSFromRangeQueries,
  getFullTextIndexWordsForItem,
} from "./FullTextSearchHelpers";
import {
  StoreSchema,
  DbProvider,
  DbSchema,
  DbTransaction,
  DbIndex,
  IndexSchema,
  DbStore,
  QuerySortOrder,
  ItemType,
  KeyPathType,
  KeyType,
} from "./ObjectStoreProvider";
import {
  arrayify,
  serializeKeyToString,
  formListOfSerializedKeys,
  getSerializedKeyForKeypath,
  getValueForSingleKeypath,
  MAX_COUNT,
  trimArray,
} from "./ObjectStoreProviderUtils";
import {
  TransactionToken,
  TransactionLockHelper,
} from "./TransactionLockHelper";
import {
  empty,
  RedBlackTreeStructure,
  set,
  iterateFromIndex,
  iterateKeysFromFirst,
  get,
  iterateKeysFromLast,
  has,
  remove,
  iterateFromFirst,
} from "@collectable/red-black-tree";
import { IRollbackMap, makeRollbackMap } from "./RollbackMap";
export interface StoreData {
  data: Map<string, ItemType>;
  indices: Map<string, InMemoryIndex>;
  schema: StoreSchema;
}

// Very simple in-memory dbprov ider for handling IE inprivate windows (and unit tests, maybe?)
export class InMemoryProvider extends DbProvider {
  private _stores: Map<string, StoreData> = new Map();

  private _lockHelper: TransactionLockHelper | undefined;

  open(
    dbName: string,
    schema: DbSchema,
    wipeIfExists: boolean,
    verbose: boolean
  ): Promise<void> {
    super.open(dbName, schema, wipeIfExists, verbose);

    each(this._schema!!!.stores, (storeSchema) => {
      this._stores.set(storeSchema.name, {
        schema: storeSchema,
        data: new Map(),
        indices: new Map(),
      });
    });

    this._lockHelper = new TransactionLockHelper(schema, true);

    return Promise.resolve<void>(void 0);
  }

  protected _deleteDatabaseInternal() {
    return Promise.resolve();
  }

  openTransaction(
    storeNames: string[],
    writeNeeded: boolean
  ): Promise<DbTransaction> {
    return this._lockHelper!!!.openTransaction(storeNames, writeNeeded).then(
      (token: any) =>
        new InMemoryTransaction(this, this._lockHelper!!!, token, writeNeeded)
    );
  }

  close(): Promise<void> {
    return this._lockHelper!!!.closeWhenPossible().then(() => {
      this._stores = new Map();
    });
  }

  internal_getStore(name: string): StoreData {
    return this._stores.get(name)!!!;
  }
}

// Notes: Doesn't limit the stores it can fetch to those in the stores it was "created" with, nor does it handle read-only transactions
class InMemoryTransaction implements DbTransaction {
  private _stores: Map<string, InMemoryStore> = new Map();
  private _openTimer: number | undefined;
  constructor(
    private _prov: InMemoryProvider,
    private _lockHelper: TransactionLockHelper,
    private _transToken: TransactionToken,
    writeNeeded: boolean
  ) {
    // Close the transaction on the next tick.  By definition, anything is completed synchronously here, so after an event tick
    // goes by, there can't have been anything pending.
    if (writeNeeded) {
      this._openTimer = setTimeout(() => {
        this._openTimer = undefined;
        this._commitTransaction();
        this._lockHelper.transactionComplete(this._transToken);
      }, 0) as any as number;
    } else {
      this._openTimer = undefined;
      this._commitTransaction();
      this._lockHelper.transactionComplete(this._transToken);
    }
  }

  private _commitTransaction(): void {
    this._stores.forEach((store) => {
      store.internal_commitPendingData();
    });
    this._stores.clear();
  }

  getCompletionPromise(): Promise<void> {
    return this._transToken.completionPromise;
  }

  abort(): void {
    this._stores.forEach((store) => {
      store.internal_rollbackPendingData();
    });

    if (this._openTimer) {
      clearTimeout(this._openTimer);
      this._openTimer = undefined;
    }

    this._lockHelper.transactionFailed(
      this._transToken,
      "InMemoryTransaction Aborted"
    );
  }

  markCompleted(): void {
    // noop
  }

  getStore(storeName: string): DbStore {
    if (!includes(arrayify(this._transToken.storeNames), storeName)) {
      throw new Error(
        "Store not found in transaction-scoped store list: " + storeName
      );
    }
    const existingStore = this._stores.get(storeName);
    if (existingStore !== undefined) {
      return existingStore;
    }
    const store = this._prov.internal_getStore(storeName);
    if (!store) {
      throw new Error("Store not found: " + storeName);
    }
    const ims = new InMemoryStore(this, store);
    this._stores.set(storeName, ims);
    return ims;
  }

  internal_isOpen() {
    return !!this._openTimer;
  }
}

class InMemoryStore implements DbStore {
  private _data: IRollbackMap<string, ItemType>;
  private _storeSchema: StoreSchema;
  private _indices: Map<string, InMemoryIndex>;
  constructor(private _trans: InMemoryTransaction, storeInfo: StoreData) {
    this._storeSchema = storeInfo.schema;
    this._indices = storeInfo.indices;
    this._data = makeRollbackMap(storeInfo.data);
  }

  internal_commitPendingData(): void {
    this._data.commit();
    // Indices were already updated, theres no need to update them now.
  }

  internal_rollbackPendingData(): void {
    this._data.rollback();

    // Recreate all indexes on a roll back.
    each(this._storeSchema.indexes, (index) => {
      this._indices.set(
        index.name,
        new InMemoryIndex(
          this._data.current,
          index,
          this._storeSchema.primaryKeyPath
        )
      );
    });
  }

  get(key: KeyType): Promise<ItemType | undefined> {
    const joinedKey = attempt(() => {
      return serializeKeyToString(key, this._storeSchema.primaryKeyPath);
    });
    if (isError(joinedKey)) {
      return Promise.reject(joinedKey);
    }

    return Promise.resolve(this._data.get(joinedKey));
  }

  getMultiple(keyOrKeys: KeyType | KeyType[]): Promise<ItemType[]> {
    const joinedKeys = attempt(() => {
      return formListOfSerializedKeys(
        keyOrKeys,
        this._storeSchema.primaryKeyPath
      );
    });
    if (isError(joinedKeys)) {
      return Promise.reject(joinedKeys);
    }

    return Promise.resolve(
      compact(joinedKeys.map((key) => this._data.get(key)))
    );
  }

  put(itemOrItems: ItemType | ItemType[]): Promise<void> {
    if (!this._trans.internal_isOpen()) {
      return Promise.reject<void>("InMemoryTransaction already closed");
    }
    const err = attempt(() => {
      each(arrayify(itemOrItems), (item) => {
        let pk = getSerializedKeyForKeypath(
          item,
          this._storeSchema.primaryKeyPath
        )!!!;
        const existingItem = this._data.get(pk);
        if (existingItem) {
          // We're going to overwrite the PK anyways - don't remove PK
          this._removeFromIndices(
            pk,
            existingItem,
            /** RemovePrimaryKey */ false
          );
        }
        this._data.set(pk, item);
        (this.openPrimaryKey() as InMemoryIndex).put(item);
        if (this._storeSchema.indexes) {
          for (const index of this._storeSchema.indexes) {
            (this.openIndex(index.name) as InMemoryIndex).put(item);
          }
        }
      });
    });
    if (err) {
      return Promise.reject<void>(err);
    }
    return Promise.resolve<void>(void 0);
  }

  remove(keyOrKeys: KeyType | KeyType[]): Promise<void> {
    if (!this._trans.internal_isOpen()) {
      return Promise.reject<void>("InMemoryTransaction already closed");
    }

    const joinedKeys = attempt(() => {
      return formListOfSerializedKeys(
        keyOrKeys,
        this._storeSchema.primaryKeyPath
      );
    });
    if (isError(joinedKeys)) {
      return Promise.reject(joinedKeys);
    }

    return this._removeInternal(joinedKeys);
  }

  removeRange(
    indexName: string,
    keyLowRange: KeyType,
    keyHighRange: KeyType,
    lowRangeExclusive?: boolean,
    highRangeExclusive?: boolean
  ): Promise<void> {
    if (!this._trans.internal_isOpen()) {
      return Promise.reject<void>("InMemoryTransaction already closed");
    }
    const index = attempt(() => {
      return indexName ? this.openIndex(indexName) : this.openPrimaryKey();
    });
    if (!index || isError(index)) {
      return Promise.reject<void>('Index "' + indexName + '" not found');
    }
    return index
      .getKeysForRange(
        keyLowRange,
        keyHighRange,
        lowRangeExclusive,
        highRangeExclusive
      )
      .then((keys) => {
        return this._removeInternal(keys);
      });
  }

  openPrimaryKey(): DbIndex {
    if (!this._indices.get("pk")) {
      this._indices.set(
        "pk",
        new InMemoryIndex(
          this._data.current,
          undefined as any,
          this._storeSchema.primaryKeyPath
        )
      );
    }
    const index = this._indices.get("pk")!!!;
    index.internal_SetTransaction(this._trans);
    return index;
  }

  openIndex(indexName: string): DbIndex {
    let indexSchema = find(
      this._storeSchema.indexes,
      (idx) => idx.name === indexName
    );
    if (!indexSchema) {
      throw new Error("Index not found: " + indexName);
    }

    if (!this._indices.has(indexSchema.name)) {
      this._indices.set(
        indexSchema.name,
        new InMemoryIndex(
          this._data.current,
          indexSchema,
          this._storeSchema.primaryKeyPath
        )
      );
    }
    const index = this._indices.get(indexSchema.name)!!!;
    index.internal_SetTransaction(this._trans);
    return index;
  }

  clearAllData(): Promise<void> {
    if (!this._trans.internal_isOpen()) {
      return Promise.reject<void>("InMemoryTransaction already closed");
    }

    this._data.clear();
    each(this._storeSchema.indexes, (index) => {
      this._indices.set(
        index.name,
        new InMemoryIndex(
          this._data.current,
          index,
          this._storeSchema.primaryKeyPath
        )
      );
    });
    return Promise.resolve<void>(void 0);
  }

  private _removeInternal(keys: string[]): Promise<void> {
    if (!this._trans.internal_isOpen()) {
      return Promise.reject<void>("InMemoryTransaction already closed");
    }

    each(keys, (key) => {
      const existingItem = this._data.get(key);
      this._data.delete(key);
      if (existingItem) {
        this._removeFromIndices(key, existingItem, /* RemovePK */ true);
      }
    });

    return Promise.resolve<void>(void 0);
  }

  private _removeFromIndices(
    key: string,
    item: ItemType,
    removePrimaryKey: boolean
  ) {
    // Don't need to remove from primary key on Puts because set is enough
    // 1. If it's an existing key then it will get overwritten
    // 2. If it's a new key then we need to add it
    if (removePrimaryKey) {
      (this.openPrimaryKey() as InMemoryIndex).remove(key);
    }

    each(this._storeSchema.indexes, (index) => {
      const ind = this.openIndex(index.name) as InMemoryIndex;
      const keys = ind.internal_getKeysFromItem(item);
      each(keys, (key) => ind.remove(key));
    });
  }
}

// Note: Currently maintains nothing interesting -- rebuilds the results every time from scratch.  Scales like crap.
class InMemoryIndex extends DbIndexFTSFromRangeQueries {
  private _rbIndex: RedBlackTreeStructure<string, ItemType[]>;
  private _trans?: InMemoryTransaction;
  constructor(
    _mergedData: Map<string, ItemType>,
    indexSchema: IndexSchema,
    primaryKeyPath: KeyPathType
  ) {
    super(indexSchema, primaryKeyPath);
    this._rbIndex = empty<string, ItemType[]>(
      (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0),
      true
    );
    this.put(values(_mergedData), true);
  }

  public internal_SetTransaction(trans: InMemoryTransaction) {
    this._trans = trans;
  }

  public internal_getKeysFromItem(item: ItemType) {
    let keys: string[] | undefined;
    if (this._indexSchema && this._indexSchema!!!.fullText) {
      keys = map(
        getFullTextIndexWordsForItem(<string>this._keyPath, item),
        (val) => serializeKeyToString(val, <string>this._keyPath)
      );
    } else if (this._indexSchema && this._indexSchema!!!.multiEntry) {
      // Have to extract the multiple entries into this alternate table...
      const valsRaw = getValueForSingleKeypath(item, <string>this._keyPath);
      if (valsRaw) {
        keys = map(arrayify(valsRaw), (val) =>
          serializeKeyToString(val, <string>this._keyPath)
        );
      }
    } else {
      keys = [getSerializedKeyForKeypath(item, this._keyPath)!!!];
    }
    return keys;
  }

  // Warning: This function can throw, make sure to trap.
  public put(
    itemOrItems: ItemType | ItemType[],
    skipTransactionOnCreation?: boolean
  ): void {
    if (!skipTransactionOnCreation && !this._trans!.internal_isOpen()) {
      throw new Error("InMemoryTransaction already closed");
    }
    const items = arrayify(itemOrItems);
    // If it's not the PK index, re-pivot the data to be keyed off the key value built from the keypath
    each(items, (item) => {
      // Each item may be non-unique so store as an array of items for each key
      const keys = this.internal_getKeysFromItem(item);

      each(keys, (key) => {
        // For non-unique indexes we want to overwrite
        if (!this.isUniqueIndex() && has(key, this._rbIndex)) {
          const existingItems = get(key, this._rbIndex)!!! as ItemType[];
          existingItems.push(item);
          set<string, ItemType[]>(key, existingItems, this._rbIndex);
        } else {
          set(key, [item], this._rbIndex);
        }
      });
    });
  }

  isUniqueIndex(): boolean {
    // An index is unique if it's the primary key (undefined index schema)
    // Or the index has defined itself as unique
    return (
      this._indexSchema === undefined ||
      (this._indexSchema && this._indexSchema.unique === true)
    );
  }

  getMultiple(keyOrKeys: KeyType | KeyType[]): Promise<ItemType[]> {
    const joinedKeys = attempt(() => {
      return formListOfSerializedKeys(keyOrKeys, this._keyPath);
    });
    if (isError(joinedKeys)) {
      return Promise.reject(joinedKeys);
    }

    let values = [] as ItemType[];
    for (const key of joinedKeys) {
      values.push(get(key, this._rbIndex) as ItemType[]);
    }
    return Promise.resolve(compact(flatten(values)));
  }

  public remove(key: string, skipTransactionOnCreation?: boolean) {
    if (!skipTransactionOnCreation && !this._trans!.internal_isOpen()) {
      throw new Error("InMemoryTransaction already closed");
    }
    remove(key, this._rbIndex);
  }

  getAll(
    reverseOrSortOrder?: boolean | QuerySortOrder,
    limit?: number,
    offset?: number
  ): Promise<ItemType[]> {
    const definedLimit = limit
      ? limit
      : this.isUniqueIndex()
      ? this._rbIndex._size
      : MAX_COUNT;
    let definedOffset = offset ? offset : 0;
    const data = new Array<ItemType>(definedLimit);
    const reverse =
      reverseOrSortOrder === true ||
      reverseOrSortOrder === QuerySortOrder.Reverse;
    // when index is not unique, we cannot use offset as a starting index
    const iterator = iterateFromIndex(
      reverse,
      this.isUniqueIndex() ? definedOffset : 0,
      this._rbIndex
    );
    let i = 0;
    for (const item of iterator) {
      // when index is not unique, each node may contain multiple items
      if (!this.isUniqueIndex()) {
        let count = item.value.length;
        const minOffsetCount = Math.min(count, definedOffset);
        count -= minOffsetCount;
        definedOffset -= minOffsetCount;
        // we have skipped all values in this index, go to the next one
        if (count === 0) {
          continue;
        }

        const values = this._getKeyValues(
          item.key,
          definedLimit - i,
          item.value.length - count,
          reverse
        );

        values.forEach((v, j) => {
          data[i + j] = v;
        });

        i += values.length;
      } else {
        data[i] = item.value[0];
        i++;
      }

      if (i >= definedLimit) {
        break;
      }
    }
    // if index is not unique, trim the empty slots in data
    // if we used MAX_COUNT to construct it.
    if (!this.isUniqueIndex() && i !== definedLimit) {
      return Promise.resolve(trimArray(data, i));
    } else {
      return Promise.resolve(data);
    }
  }

  getOnly(
    key: KeyType,
    reverseOrSortOrder?: boolean | QuerySortOrder,
    limit?: number,
    offset?: number
  ): Promise<ItemType[]> {
    return this.getRange(
      key,
      key,
      false,
      false,
      reverseOrSortOrder,
      limit,
      offset
    );
  }

  getRange(
    keyLowRange: KeyType,
    keyHighRange: KeyType,
    lowRangeExclusive?: boolean,
    highRangeExclusive?: boolean,
    reverseOrSortOrder?: boolean | QuerySortOrder,
    limit?: number,
    offset?: number
  ): Promise<ItemType[]> {
    const values = attempt(() => {
      const reverse =
        reverseOrSortOrder === true ||
        reverseOrSortOrder === QuerySortOrder.Reverse;
      limit = limit
        ? limit
        : this.isUniqueIndex()
        ? this._rbIndex._size
        : MAX_COUNT;
      offset = offset ? offset : 0;
      const keyLow = serializeKeyToString(keyLowRange, this._keyPath);
      const keyHigh = serializeKeyToString(keyHighRange, this._keyPath);
      const iterator = reverse
        ? iterateKeysFromLast(this._rbIndex)
        : iterateKeysFromFirst(this._rbIndex);
      let values = [] as ItemType[];
      for (const key of iterator) {
        if (
          (key > keyLow || (key === keyLow && !lowRangeExclusive)) &&
          (key < keyHigh || (key === keyHigh && !highRangeExclusive))
        ) {
          if (offset > 0) {
            if (this.isUniqueIndex()) {
              offset--;
              continue;
            } else {
              const idxValues = get(key, this._rbIndex) as ItemType[];
              offset -= idxValues.length;
              // if offset >= 0, we skipped just enough, or we still need to skip more
              // if offset < 0, we need to get some of the values from the index
              if (offset >= 0) {
                continue;
              }
            }
          }
          if (values.length >= limit) {
            break;
          }

          if (this.isUniqueIndex()) {
            values = values.concat(get(key, this._rbIndex) as ItemType[]);
          } else {
            values = values.concat(
              this._getKeyValues(
                key,
                limit - values.length,
                Math.abs(offset),
                reverse
              )
            );

            if (offset < 0) {
              offset = 0;
            }
          }
        }
      }
      return values;
    });
    if (isError(values)) {
      return Promise.reject(values);
    }

    return Promise.resolve(values);
  }

  getKeysForRange(
    keyLowRange: KeyType,
    keyHighRange: KeyType,
    lowRangeExclusive?: boolean,
    highRangeExclusive?: boolean
  ): Promise<any[]> {
    const keys = attempt(() => {
      return this._getKeysForRange(
        keyLowRange,
        keyHighRange,
        lowRangeExclusive,
        highRangeExclusive
      );
    });
    if (isError(keys)) {
      return Promise.reject(void 0);
    }
    return Promise.resolve(keys);
  }

  /**
   * Utility function to simplify offset/limit checks and allow a negative offset. Retrieves values associated with the given key
   * @param key primary key
   * @param limit
   * @param offset can be neagtive, treated the same way as 0
   * @param reverse
   * @returns value associated with given key, undefined if the key is not found.
   */
  private _getKeyValues(
    key: string,
    limit: number,
    offset: number,
    reverse: boolean
  ): ItemType[] {
    if (limit <= 0) {
      return [];
    }
    const idxValues = get(key, this._rbIndex) as ItemType[];

    // get may return undefined, if the key is not found
    if (!idxValues) {
      return idxValues;
    }

    if (offset >= idxValues.length) {
      return [];
    }

    // Perf optimisation. No items to skip, and limit is at least the number of items we have in the index.
    // we know that we will need the whole index values array to fulfill the results,
    // skip using take/drop, return the whole array immediately.
    if (offset <= 0 && limit >= idxValues.length) {
      return reverse ? idxValues.slice().reverse() : idxValues;
    }

    const itemsToDrop = Math.min(limit, offset);
    const itemsToTake = Math.min(limit, idxValues.length - offset);
    return reverse
      ? takeRight(dropRight(idxValues, itemsToDrop), itemsToTake)
      : take(drop(idxValues, itemsToDrop), itemsToTake);
  }

  // Warning: This function can throw, make sure to trap.
  private _getKeysForRange(
    keyLowRange: KeyType,
    keyHighRange: KeyType,
    lowRangeExclusive?: boolean,
    highRangeExclusive?: boolean
  ): string[] {
    const keyLow = serializeKeyToString(keyLowRange, this._keyPath);
    const keyHigh = serializeKeyToString(keyHighRange, this._keyPath);
    const iterator = iterateKeysFromFirst(this._rbIndex);
    const keys = [];
    for (const key of iterator) {
      if (
        (key > keyLow || (key === keyLow && !lowRangeExclusive)) &&
        (key < keyHigh || (key === keyHigh && !highRangeExclusive))
      ) {
        keys.push(key);
      }
    }
    return keys;
  }

  // Warning: This function can throw, make sure to trap.
  private _getKeyCountForRange(
    keyLowRange: KeyType,
    keyHighRange: KeyType,
    lowRangeExclusive?: boolean,
    highRangeExclusive?: boolean
  ): number {
    const keyLow = serializeKeyToString(keyLowRange, this._keyPath);
    const keyHigh = serializeKeyToString(keyHighRange, this._keyPath);
    const iterator = iterateFromFirst(this._rbIndex);
    let keyCount = 0;
    for (const item of iterator) {
      if (
        (item.key > keyLow || (item.key === keyLow && !lowRangeExclusive)) &&
        (item.key < keyHigh || (item.key === keyHigh && !highRangeExclusive))
      ) {
        if (this.isUniqueIndex()) {
          keyCount++;
        } else {
          keyCount += item.value.length;
        }
      }
    }
    return keyCount;
  }

  countAll(): Promise<number> {
    if (this.isUniqueIndex()) {
      return Promise.resolve(this._rbIndex._size);
    } else {
      const keyCount = attempt(() => {
        const iterator = iterateFromFirst(this._rbIndex);
        let keyCount = 0;
        for (const item of iterator) {
          keyCount += item.value.length;
        }
        return keyCount;
      });
      if (isError(keyCount)) {
        return Promise.reject(keyCount);
      }

      return Promise.resolve(keyCount);
    }
  }

  countOnly(key: KeyType): Promise<number> {
    return this.countRange(key, key, false, false);
  }

  countRange(
    keyLowRange: KeyType,
    keyHighRange: KeyType,
    lowRangeExclusive?: boolean,
    highRangeExclusive?: boolean
  ): Promise<number> {
    if (this.isUniqueIndex()) {
      const keys = attempt(() => {
        return this._getKeysForRange(
          keyLowRange,
          keyHighRange,
          lowRangeExclusive,
          highRangeExclusive
        );
      });

      if (isError(keys)) {
        return Promise.reject(keys);
      }

      return Promise.resolve(keys.length);
    } else {
      const keyCount = attempt(() => {
        return this._getKeyCountForRange(
          keyLowRange,
          keyHighRange,
          lowRangeExclusive,
          highRangeExclusive
        );
      });

      if (isError(keyCount)) {
        return Promise.reject(keyCount);
      }

      return Promise.resolve(keyCount);
    }
  }
}
