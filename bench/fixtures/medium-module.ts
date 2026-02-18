// Pagination, sorting, and filtering utilities
// Used across data table components and API endpoints

export interface PaginationOptions {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'startsWith';

export interface FilterCriteria<T> {
  field: keyof T;
  operator: FilterOperator;
  value: unknown;
}

/**
 * Paginates an array of items based on the given options.
 * Returns a PaginatedResult containing the page slice and metadata.
 */
export function paginate<T>(items: T[], options: PaginationOptions): PaginatedResult<T> {
  const { page, pageSize } = options;
  const total = items.length;
  const totalPages = Math.ceil(total / pageSize);
  const clampedPage = Math.max(1, Math.min(page, totalPages || 1));
  const startIndex = (clampedPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, total);

  return {
    data: items.slice(startIndex, endIndex),
    total,
    page: clampedPage,
    pageSize,
    totalPages,
    hasNextPage: clampedPage < totalPages,
    hasPreviousPage: clampedPage > 1,
  };
}

/**
 * Sorts an array of objects by a given key and direction.
 * Handles string and number comparisons automatically.
 */
export function sortBy<T extends Record<string, unknown>>(
  items: T[],
  key: keyof T,
  direction: 'asc' | 'desc' = 'asc'
): T[] {
  const sorted = [...items].sort((a, b) => {
    const valA = a[key];
    const valB = b[key];

    if (valA === null || valA === undefined) return 1;
    if (valB === null || valB === undefined) return -1;

    if (typeof valA === 'string' && typeof valB === 'string') {
      return valA.localeCompare(valB);
    }

    if (typeof valA === 'number' && typeof valB === 'number') {
      return valA - valB;
    }

    return String(valA).localeCompare(String(valB));
  });

  return direction === 'desc' ? sorted.reverse() : sorted;
}

/**
 * Applies a single filter criterion to an array of items.
 */
export const applyFilter = <T extends Record<string, unknown>>(
  items: T[],
  criteria: FilterCriteria<T>
): T[] => {
  return items.filter((item) => {
    const value = item[criteria.field];
    const target = criteria.value;

    switch (criteria.operator) {
      case 'eq':
        return value === target;
      case 'neq':
        return value !== target;
      case 'gt':
        return typeof value === 'number' && typeof target === 'number' && value > target;
      case 'gte':
        return typeof value === 'number' && typeof target === 'number' && value >= target;
      case 'lt':
        return typeof value === 'number' && typeof target === 'number' && value < target;
      case 'lte':
        return typeof value === 'number' && typeof target === 'number' && value <= target;
      case 'contains':
        return typeof value === 'string' && typeof target === 'string' && value.includes(target);
      case 'startsWith':
        return typeof value === 'string' && typeof target === 'string' && value.startsWith(target);
      default:
        return true;
    }
  });
};

/**
 * Applies multiple filter criteria with AND logic.
 */
export function applyFilters<T extends Record<string, unknown>>(
  items: T[],
  criteria: FilterCriteria<T>[]
): T[] {
  return criteria.reduce((filtered, criterion) => applyFilter(filtered, criterion), items);
}

/**
 * Combines sorting, filtering, and pagination into a single pipeline.
 * This is the primary entry point for table data processing.
 */
export function queryCollection<T extends Record<string, unknown>>(
  items: T[],
  options: PaginationOptions,
  filters: FilterCriteria<T>[] = []
): PaginatedResult<T> {
  let processed = applyFilters(items, filters);

  if (options.sortBy) {
    processed = sortBy(processed, options.sortBy as keyof T, options.sortDirection);
  }

  return paginate(processed, options);
}

/**
 * Builds a human-readable summary of the current query state.
 * Useful for accessibility labels and debug logging.
 */
export const buildQuerySummary = (
  result: PaginatedResult<unknown>,
  activeFilters: number
): string => {
  const rangeStart = (result.page - 1) * result.pageSize + 1;
  const rangeEnd = Math.min(result.page * result.pageSize, result.total);

  let summary = `Showing ${rangeStart}-${rangeEnd} of ${result.total} items`;

  if (activeFilters > 0) {
    summary += ` (${activeFilters} filter${activeFilters > 1 ? 's' : ''} applied)`;
  }

  if (result.totalPages > 1) {
    summary += ` — Page ${result.page} of ${result.totalPages}`;
  }

  return summary;
};
