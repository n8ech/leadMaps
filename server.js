const axios = require('axios');
const fs = require('fs').promises;
const mongoose = require('mongoose');
require('dotenv').config({path:'./.env.local'});

// Récupération des variables d'environnement
const PLACE_API_KEY = process.env.PLACE_API_KEY;
const DISCORD_WEBHOOK_URI = process.env.DISCORD_WEBHOOK_URI;
const DB_URI = process.env.DB_URI;

// Schéma MongoDB pour les établissements
const placeSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  googleMapsUri: String,
  types: [String],
  internationalPhoneNumber: String,
  websiteUri: String,
  locationId: Number
});

const Place = mongoose.model('Place', placeSchema);

// Types d'établissements à rechercher
const PLACE_TYPES = ['store', 'restaurant', 'lodging', 'bar'];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readLocations() {
  const data = await fs.readFile('locations.json', 'utf8');
  return JSON.parse(data);
}

async function readCheckpoint() {
  try {
    const checkpoint = await fs.readFile('checkpoint.txt', 'utf8');
    return parseInt(checkpoint.trim());
  } catch (error) {
    return 0;
  }
}

// Fonction pour écrire le checkpoint
async function writeCheckpoint(id) {
  await fs.writeFile('checkpoint.txt', id.toString());
}

// Fonction pour envoyer une alerte Discord
async function sendDiscordAlert(placeInfo) {
  const message = {
    content: `Nouvel établissement sans site web détecté !`,
    embeds: [{
      title: placeInfo.name,
      description: `Type: ${placeInfo.types.join(', ')}`,
      fields: [
        { name: 'Téléphone', value: placeInfo.internationalPhoneNumber || 'Non disponible' },
        { name: 'Google Maps', value: placeInfo.googleMapsUri }
      ]
    }]
  };
  try {
    await axios.post(DISCORD_WEBHOOK_URI, message);
    console.log('Alerte Discord envoyée avec succès');
    await delay(2000); // Attendre 2 secondes entre chaque envoi
  } catch (error) {
    console.error('Erreur lors de l\'envoi de l\'alerte Discord:', error);
  }
}

async function nearbySearch(location, type) {
  const params = {
    includedTypes: [type],
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: {
          latitude: location.latitude,
          longitude: location.longitude
        },
        radius: 2000.0
      }
    },
    "rankPreference": "DISTANCE"
  };

  try {
    const response = await axios.post(
      'https://places.googleapis.com/v1/places:searchNearby',
      params,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': PLACE_API_KEY,
          'X-Goog-FieldMask': 'places.id,places.googleMapsUri,places.types,places.displayName'
        }
      }
    );

    return response.data.places || [];
  } catch (error) {
    console.error('Erreur lors de la recherche nearby:', error.response ? error.response.data : error.message);
    throw error;
  }
}

async function getPlaceDetails(placeId) {
  const response = await axios.get(
    `https://places.googleapis.com/v1/places/${placeId}`,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PLACE_API_KEY,
        'X-Goog-FieldMask': 'internationalPhoneNumber,websiteUri'
      }
    }
  );

  return response.data;
}

async function processPlace(place, location) {
  let existingPlace = await Place.findOne({ id: place.id });

  if (existingPlace) {
    // Mise à jour des types si de nouveaux types sont trouvés
    const newTypes = place.types.filter(type => !existingPlace.types.includes(type));
    if (newTypes.length > 0) {
      existingPlace.types = [...new Set([...existingPlace.types, ...newTypes])];
      await existingPlace.save();
    }
  } else {
    const placeDetails = await getPlaceDetails(place.id);

    const newPlace = new Place({
      id: place.id,
      googleMapsUri: place.googleMapsUri,
      types: place.types,
      internationalPhoneNumber: placeDetails.internationalPhoneNumber,
      websiteUri: placeDetails.websiteUri,
      locationId: location.id
    });

    await newPlace.save();

    if (!placeDetails.websiteUri) {
      await sendDiscordAlert({
        name: place.displayName?.text || 'Nom inconnu',
        types: place.types,
        internationalPhoneNumber: placeDetails.internationalPhoneNumber,
        googleMapsUri: place.googleMapsUri
      });
    }
  }
}

async function main() {
  await mongoose.connect(DB_URI);

  const locations = await readLocations();
  let checkpointId = await readCheckpoint();

  let processedCount = 0;
  const maxProcessed = 10;

  for (let i = 0; i < locations.length && processedCount < maxProcessed; i++) {
    const location = locations[i];
    
    if (location.id <= checkpointId) continue;

    const allPlaces = new Set();

    for (const type of PLACE_TYPES) {
      const places = await nearbySearch(location, type);
      places.forEach(place => allPlaces.add(JSON.stringify(place)));
    }

    for (const placeString of allPlaces) {
      const place = JSON.parse(placeString);
      await processPlace(place, location);
    }

    checkpointId = location.id;
    processedCount++;
  }

  await writeCheckpoint(checkpointId);
  await mongoose.disconnect();
}

main().catch(console.error);