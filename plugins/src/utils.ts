export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function isIgnoredSubjectSeparator(char: string): boolean {
  return /\s|-/.test(char);
}

export function parseSubjectCommand(subject: string, prefix: string): string | null {
  const trimmedPrefix = prefix.trim();
  const hasOptionalColon = trimmedPrefix.endsWith(":");
  const requiredPrefix = hasOptionalColon ? trimmedPrefix.slice(0, -1) : trimmedPrefix;
  let subjectIndex = 0;

  for (const prefixCharacter of requiredPrefix) {
    if (isIgnoredSubjectSeparator(prefixCharacter)) continue;
    while (
      subjectIndex < subject.length &&
      isIgnoredSubjectSeparator(subject[subjectIndex] ?? "")
    ) {
      subjectIndex += 1;
    }
    if (
      subjectIndex >= subject.length ||
      subject[subjectIndex]?.toLowerCase() !== prefixCharacter.toLowerCase()
    ) {
      return null;
    }
    subjectIndex += 1;
  }

  const matchedPrefixEnd = subjectIndex;
  while (
    subjectIndex < subject.length &&
    isIgnoredSubjectSeparator(subject[subjectIndex] ?? "")
  ) {
    subjectIndex += 1;
  }
  if (hasOptionalColon && subject[subjectIndex] === ":") {
    subjectIndex += 1;
  } else if (matchedPrefixEnd === subjectIndex && /^[a-z]$/i.test(subject[subjectIndex] ?? "")) {
    return null;
  }
  while (
    subjectIndex < subject.length &&
    isIgnoredSubjectSeparator(subject[subjectIndex] ?? "")
  ) {
    subjectIndex += 1;
  }

  return subject.slice(subjectIndex).trim();
}

export function isImageAttachment(contentType: { contentType: string }): boolean {
  return contentType.contentType.toLowerCase().startsWith("image/");
}
