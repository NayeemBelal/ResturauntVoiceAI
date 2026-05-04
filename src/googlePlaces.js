require('dotenv').config();

const API_KEY = process.env.GOOGLE_MAPS_PLACES_KEY;
const BASE_URL = 'https://places.googleapis.com/v1/places';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

async function findPlaceId(restaurantName) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`${BASE_URL}:searchText`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName',
    },
    body: JSON.stringify({ textQuery: restaurantName }),
  });

  const data = await res.json();
  if (!data.places?.length) {
    throw new Error(`Place not found for: ${restaurantName}`);
  }

  return data.places[0].id;
}

async function getHours(placeId) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`${BASE_URL}/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'displayName,regularOpeningHours,currentOpeningHours',
    },
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`Place details error: ${data.error.message}`);
  }

  const oh = data.regularOpeningHours;
  return {
    name: data.displayName?.text ?? '',
    openNow: data.currentOpeningHours?.openNow ?? null,
    weekdayText: oh?.weekdayDescriptions ?? [],
    periods: oh?.periods ?? [],
  };
}

async function getFormattedHours(placeId) {
  const { weekdayText, openNow } = await getHours(placeId);

  // weekdayDescriptions starts on Monday (index 0 = Monday per Google's new API)
  // Remap to a day-keyed object: { monday: "9:00 AM – 10:00 PM", ... }
  const hours = {};
  const orderedDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  weekdayText.forEach((line, i) => {
    // Each line looks like "Monday: 9:00 AM – 10:00 PM"
    const colonIdx = line.indexOf(':');
    const timeStr = colonIdx !== -1 ? line.slice(colonIdx + 1).trim() : line;
    hours[orderedDays[i]] = timeStr;
  });

  return {
    hours,
    openNow,
    unavailable: weekdayText.length === 0,
  };
}

module.exports = { findPlaceId, getHours, getFormattedHours };
