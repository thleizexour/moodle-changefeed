function unfoldIcs(text) {
  return text.replace(/\r?\n[ \t]/g, "");
}

function unescapeIcs(value = "") {
  return value
    .replaceAll("\\n", "\n")
    .replaceAll("\\N", "\n")
    .replaceAll("\\,", ",")
    .replaceAll("\\;", ";")
    .replaceAll("\\\\", "\\");
}

function parseIcsDate(value) {
  if (!value) return null;
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  const match = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/
  );
  if (!match) return value;
  const [, year, month, day, hour, minute, second, utc] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${utc ? "Z" : ""}`;
}

function parseProperty(line) {
  const separator = line.indexOf(":");
  if (separator < 0) return null;
  const descriptor = line.slice(0, separator);
  const [rawName, ...rawParameters] = descriptor.split(";");
  const parameters = {};
  for (const parameter of rawParameters) {
    const equals = parameter.indexOf("=");
    if (equals > 0) {
      parameters[parameter.slice(0, equals).toUpperCase()] = parameter.slice(
        equals + 1
      );
    }
  }
  return {
    name: rawName.toUpperCase(),
    parameters,
    value: line.slice(separator + 1)
  };
}

export function parseMoodleIcs(text) {
  if (!text.includes("BEGIN:VCALENDAR")) {
    throw new Error("内容不是有效的 iCalendar 数据。");
  }
  const events = new Map();
  const unfolded = unfoldIcs(text);
  for (const block of unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)) {
    const values = {};
    const parameters = {};
    for (const line of block[1].split(/\r?\n/)) {
      const property = parseProperty(line);
      if (!property) continue;
      values[property.name] = property.value;
      parameters[property.name] = property.parameters;
    }
    if (!values.UID) continue;
    const uid = unescapeIcs(values.UID);
    const recurrenceId = unescapeIcs(values["RECURRENCE-ID"] || "");
    const identity = recurrenceId ? `${uid}:${recurrenceId}` : uid;
    const sequence = Number(values.SEQUENCE || 0);
    const event = {
      externalId: `moodle:${identity}`,
      uid,
      recurrenceId: recurrenceId || null,
      title: unescapeIcs(values.SUMMARY || "未命名 Moodle 事项"),
      description: unescapeIcs(values.DESCRIPTION || ""),
      start: parseIcsDate(values.DTSTART),
      end: parseIcsDate(values.DTEND),
      startTimeZone: parameters.DTSTART?.TZID || null,
      endTimeZone: parameters.DTEND?.TZID || null,
      sourceUrl: unescapeIcs(values.URL || "")
    };
    const previous = events.get(identity);
    if (!previous || sequence >= previous.sequence) {
      events.set(identity, { ...event, sequence });
    }
  }
  return [...events.values()].map(({ sequence, ...event }) => event);
}
