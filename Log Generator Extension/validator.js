const REQUIRED_FIELDS = [
  "schema_version",
  "event_id",
  "user_id",
  "device_id",
  "session_id",
  "sequence_number",
  "event_type",
  "timestamp_utc",
  "browser",
  "os",
  "domain",
  "url",
  "engagement",
  "event_properties"
];

const ALLOWED_EVENT_TYPES = new Set([
  "search",
  "page_visit",
  "page_engagement",
  "product_view",
  "ad_click",
  "video_watch",
  "content_read",
  "compare"
]);

export function validateLogs(jsonl) {
  const errors = [];
  const sessionSeq = {};

  const lines = jsonl.trim().split("\n");

  lines.forEach((line, index) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      errors.push(`Line ${index + 1}: Invalid JSON`);
      return;
    }

    // Required fields
    REQUIRED_FIELDS.forEach(f => {
      if (!(f in event)) {
        errors.push(`Line ${index + 1}: Missing field '${f}'`);
      }
    });

    // Event type
    if (!ALLOWED_EVENT_TYPES.has(event.event_type)) {
      errors.push(`Line ${index + 1}: Invalid event_type '${event.event_type}'`);
    }

    // Timestamp
    if (isNaN(Date.parse(event.timestamp_utc))) {
      errors.push(`Line ${index + 1}: Invalid timestamp`);
    }

    // Session sequence
    const sid = event.session_id;
    if (!sessionSeq[sid]) {
      sessionSeq[sid] = event.sequence_number;
      if (event.sequence_number !== 1) {
        errors.push(`Line ${index + 1}: Session '${sid}' does not start at 1`);
      }
    } else {
      if (event.sequence_number !== sessionSeq[sid] + 1) {
        errors.push(
          `Line ${index + 1}: Sequence jump in session '${sid}'`
        );
      }
      sessionSeq[sid] = event.sequence_number;
    }

    // Event-specific rules
    if (event.event_type === "search") {
      if (!event.event_properties.search_query) {
        errors.push(`Line ${index + 1}: Missing search_query`);
      }
    }

    if (event.event_type === "product_view") {
      if (!("category" in event.event_properties)) {
        errors.push(`Line ${index + 1}: product_view missing category`);
      }
    }
  });

  return errors;
}
