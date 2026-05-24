import type { Template, TemplateField } from "../types";

export interface TemplateAccuracyOptions {
  /** Maximum x/y delta, in PDF points, for a field position to be considered exact. */
  positionTolerance?: number;
  /** Maximum width/height delta, in PDF points, for a field size to be considered exact. */
  sizeTolerance?: number;
}

export interface FieldAccuracyComparison {
  expectedFieldId: string;
  predictedFieldId?: string;
  label: string;
  matched: boolean;
  issues: string[];
}

export interface TemplateAccuracyReport {
  expectedFieldCount: number;
  predictedFieldCount: number;
  matchedFieldCount: number;
  missingFieldCount: number;
  extraFieldCount: number;
  fieldAccuracy: number;
  overallAccuracy: number;
  passed: boolean;
  threshold: number;
  comparisons: FieldAccuracyComparison[];
  extraFields: TemplateField[];
}

const DEFAULT_POSITION_TOLERANCE = 6;
const DEFAULT_SIZE_TOLERANCE = 8;

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function fieldIdentityScore(expected: TemplateField, predicted: TemplateField): number {
  let score = 0;
  if (
    expected.canonicalFieldId &&
    predicted.canonicalFieldId &&
    expected.canonicalFieldId === predicted.canonicalFieldId
  ) {
    score += 5;
  }
  if (
    expected.mappedProjectKey &&
    predicted.mappedProjectKey &&
    expected.mappedProjectKey === predicted.mappedProjectKey
  ) {
    score += 3;
  }
  if (normalizeLabel(expected.label) === normalizeLabel(predicted.label)) {
    score += 2;
  }
  if (expected.pageNumber === predicted.pageNumber) {
    score += 1;
  }
  return score;
}

function findBestFieldMatch(
  expected: TemplateField,
  predictedFields: TemplateField[],
  usedPredictedIndexes: Set<number>
): { field: TemplateField; index: number } | null {
  let bestIndex = -1;
  let bestScore = 0;
  predictedFields.forEach((predicted, index) => {
    if (usedPredictedIndexes.has(index)) return;
    const score = fieldIdentityScore(expected, predicted);
    if (score === 0) return;
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });
  return bestIndex >= 0 ? { field: predictedFields[bestIndex], index: bestIndex } : null;
}

function near(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

function compareField(
  expected: TemplateField,
  predicted: TemplateField,
  options: Required<TemplateAccuracyOptions>
): string[] {
  const issues: string[] = [];
  if (expected.pageNumber !== predicted.pageNumber) {
    issues.push(`page expected ${expected.pageNumber}, got ${predicted.pageNumber}`);
  }
  if (expected.canonicalFieldId && expected.canonicalFieldId !== predicted.canonicalFieldId) {
    issues.push(
      `canonical id expected ${expected.canonicalFieldId}, got ${predicted.canonicalFieldId ?? "none"}`
    );
  }
  if (expected.mappedProjectKey && expected.mappedProjectKey !== predicted.mappedProjectKey) {
    issues.push(
      `mapping expected ${expected.mappedProjectKey}, got ${predicted.mappedProjectKey || "none"}`
    );
  }
  if ((expected.fieldKind ?? "") !== (predicted.fieldKind ?? "")) {
    issues.push(`kind expected ${expected.fieldKind ?? "none"}, got ${predicted.fieldKind ?? "none"}`);
  }
  if ((expected.fieldType ?? "") !== (predicted.fieldType ?? "")) {
    issues.push(`type expected ${expected.fieldType ?? "none"}, got ${predicted.fieldType ?? "none"}`);
  }
  if (
    !near(expected.x, predicted.x, options.positionTolerance) ||
    !near(expected.y, predicted.y, options.positionTolerance)
  ) {
    issues.push(
      `position expected (${expected.x}, ${expected.y}), got (${predicted.x}, ${predicted.y})`
    );
  }
  if (
    !near(expected.width, predicted.width, options.sizeTolerance) ||
    !near(expected.height, predicted.height, options.sizeTolerance)
  ) {
    issues.push(
      `size expected ${expected.width}x${expected.height}, got ${predicted.width}x${predicted.height}`
    );
  }
  if ((expected.checkboxValue ?? "") !== (predicted.checkboxValue ?? "")) {
    issues.push(
      `checkbox value expected ${expected.checkboxValue ?? "none"}, got ${predicted.checkboxValue ?? "none"}`
    );
  }
  return issues;
}

export function computeTemplateAccuracy(
  expectedTemplate: Pick<Template, "fields">,
  predictedTemplate: Pick<Template, "fields">,
  threshold = 1,
  options: TemplateAccuracyOptions = {}
): TemplateAccuracyReport {
  const resolvedOptions = {
    positionTolerance: options.positionTolerance ?? DEFAULT_POSITION_TOLERANCE,
    sizeTolerance: options.sizeTolerance ?? DEFAULT_SIZE_TOLERANCE,
  };
  const usedPredictedIndexes = new Set<number>();
  const comparisons = expectedTemplate.fields.map<FieldAccuracyComparison>((expectedField) => {
    const match = findBestFieldMatch(expectedField, predictedTemplate.fields, usedPredictedIndexes);
    if (!match) {
      return {
        expectedFieldId: expectedField.id,
        label: expectedField.label,
        matched: false,
        issues: ["missing field"],
      };
    }
    usedPredictedIndexes.add(match.index);
    const issues = compareField(expectedField, match.field, resolvedOptions);
    return {
      expectedFieldId: expectedField.id,
      predictedFieldId: match.field.id,
      label: expectedField.label,
      matched: issues.length === 0,
      issues,
    };
  });
  const matchedFieldCount = comparisons.filter((comparison) => comparison.matched).length;
  const extraFields = predictedTemplate.fields.filter((_, index) => !usedPredictedIndexes.has(index));
  const expectedFieldCount = expectedTemplate.fields.length;
  const predictedFieldCount = predictedTemplate.fields.length;
  const fieldAccuracy = expectedFieldCount === 0 ? 1 : matchedFieldCount / expectedFieldCount;
  const extraPenalty = predictedFieldCount === 0 ? 0 : extraFields.length / predictedFieldCount;
  const overallAccuracy = Math.max(0, fieldAccuracy - extraPenalty);

  return {
    expectedFieldCount,
    predictedFieldCount,
    matchedFieldCount,
    missingFieldCount: comparisons.filter((comparison) => !comparison.predictedFieldId).length,
    extraFieldCount: extraFields.length,
    fieldAccuracy,
    overallAccuracy,
    passed: overallAccuracy >= threshold && comparisons.every((comparison) => comparison.matched),
    threshold,
    comparisons,
    extraFields,
  };
}
