import { getDb } from "./db";

import type { Direction, RideRecord } from "@/lib/types";

/** 搭乘紀錄：個人資料，只存在本機 IndexedDB */

export function createRideRecordId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ride-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function getAllRideRecords(): Promise<RideRecord[]> {
  const records = await getDb().rideRecords.toArray();
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addRideRecord(record: RideRecord): Promise<void> {
  await getDb().rideRecords.put(record);
}

export async function deleteRideRecord(id: string): Promise<void> {
  await getDb().rideRecords.delete(id);
}

export async function deleteRideRecords(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getDb().rideRecords.bulkDelete(ids);
}

export async function findRideRecords(filter: {
  routeUID: string;
  direction: Direction;
  fromStopUID?: string | null;
  toStopUID?: string | null;
}): Promise<RideRecord[]> {
  const candidates = await getDb()
    .rideRecords.where("routeUID")
    .equals(filter.routeUID)
    .toArray();

  return candidates.filter((record) => {
    if (record.direction !== filter.direction) return false;
    if (filter.fromStopUID != null && record.fromStopUID !== filter.fromStopUID) {
      return false;
    }
    if (filter.toStopUID != null && record.toStopUID !== filter.toStopUID) return false;
    return true;
  });
}

export async function clearRideRecords(): Promise<void> {
  await getDb().rideRecords.clear();
}

/** 匯入時使用：整批取代現有紀錄 */
export async function replaceAllRideRecords(records: RideRecord[]): Promise<void> {
  const db = getDb();
  await db.transaction("rw", db.rideRecords, async () => {
    await db.rideRecords.clear();
    if (records.length > 0) await db.rideRecords.bulkPut(records);
  });
}
