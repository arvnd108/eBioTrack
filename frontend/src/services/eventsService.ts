// Owner: B (Frontend)
// Purpose: API calls for events
//
// CONTRACT 10, Collection events (backend T21). POST /api/events creates the event, its
// measurements and its samples in one transaction (at most 50 measurements and 100 samples);
// the collector is the signed-in user.

import type { CollectionEventDetail, CreateEventRequest } from '../types';
import { api } from './apiClient';

export async function createEvent(body: CreateEventRequest): Promise<CollectionEventDetail> {
  return (await api.post<CollectionEventDetail>('/events', body)).data;
}
