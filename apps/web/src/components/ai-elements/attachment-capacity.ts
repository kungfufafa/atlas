export interface AttachmentReservation {
  count: number;
  id: number;
}

export interface AttachmentReservationResult {
  overflowCount: number;
  reservation: AttachmentReservation | null;
}

/**
 * Tracks files that are already ready separately from batches still being
 * prepared. React state can lag asynchronous FileReader completions by a render,
 * so capacity checks cannot safely rely on the rendered file count alone.
 */
export class AttachmentCapacityTracker {
  private committedCount: number;
  private nextReservationId = 1;
  private readonly reservations = new Map<number, number>();

  constructor(initialCommittedCount = 0) {
    this.committedCount = Math.max(0, initialCommittedCount);
  }

  get pendingCount(): number {
    let count = 0;
    for (const reservationCount of this.reservations.values()) {
      count += reservationCount;
    }
    return count;
  }

  reserve(
    requestedCount: number,
    maxFiles?: number
  ): AttachmentReservationResult {
    const normalizedRequestedCount = Math.max(0, requestedCount);
    const capacity =
      typeof maxFiles === "number"
        ? Math.max(0, maxFiles - this.committedCount - this.pendingCount)
        : normalizedRequestedCount;
    const reservedCount = Math.min(normalizedRequestedCount, capacity);

    if (reservedCount === 0) {
      return {
        overflowCount: normalizedRequestedCount,
        reservation: null,
      };
    }

    const reservation = {
      count: reservedCount,
      id: this.nextReservationId,
    };
    this.nextReservationId += 1;
    this.reservations.set(reservation.id, reservation.count);

    return {
      overflowCount: normalizedRequestedCount - reservedCount,
      reservation,
    };
  }

  commit(reservation: AttachmentReservation, acceptedCount: number): void {
    const reservedCount = this.reservations.get(reservation.id);
    if (reservedCount === undefined) {
      return;
    }

    this.reservations.delete(reservation.id);
    this.committedCount += Math.min(reservedCount, Math.max(0, acceptedCount));
  }

  release(reservation: AttachmentReservation): void {
    this.reservations.delete(reservation.id);
  }

  isActive(reservation: AttachmentReservation): boolean {
    return this.reservations.has(reservation.id);
  }

  removeCommitted(count = 1): void {
    this.committedCount = Math.max(0, this.committedCount - Math.max(0, count));
  }

  clear(): void {
    this.committedCount = 0;
    this.reservations.clear();
  }
}
