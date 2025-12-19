export function getCurrentPosition({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocalização não suportada"));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        resolve({
          lat: latitude,
          lng: longitude,
          accuracy_m: accuracy,
          gps_timestamp: new Date(pos.timestamp).toISOString(),
        });
      },
      (err) => reject(new Error(`GPS indisponível: ${err.message}`)),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}
