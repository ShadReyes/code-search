import React, { useState, useEffect, useCallback, useMemo } from 'react';

export interface Column<T> {
  key: keyof T & string;
  label: string;
  sortable?: boolean;
  width?: number;
  render?: (value: T[keyof T], row: T) => React.ReactNode;
}

export interface DataTableProps<T extends Record<string, unknown>> {
  columns: Column<T>[];
  data: T[];
  pageSize?: number;
  searchable?: boolean;
  onRowClick?: (row: T, index: number) => void;
  emptyMessage?: string;
  loading?: boolean;
}

interface FormState {
  searchQuery: string;
  currentPage: number;
  sortColumn: string | null;
  sortDirection: 'asc' | 'desc';
}

function useFormState(initialPageSize: number) {
  const [state, setState] = useState<FormState>({
    searchQuery: '',
    currentPage: 1,
    sortColumn: null,
    sortDirection: 'asc',
  });

  const setSearchQuery = useCallback((query: string) => {
    setState((prev) => ({
      ...prev,
      searchQuery: query,
      currentPage: 1,
    }));
  }, []);

  const setCurrentPage = useCallback((page: number) => {
    setState((prev) => ({ ...prev, currentPage: page }));
  }, []);

  const toggleSort = useCallback((column: string) => {
    setState((prev) => {
      if (prev.sortColumn === column) {
        return {
          ...prev,
          sortDirection: prev.sortDirection === 'asc' ? 'desc' : 'asc',
          currentPage: 1,
        };
      }
      return {
        ...prev,
        sortColumn: column,
        sortDirection: 'asc',
        currentPage: 1,
      };
    });
  }, []);

  const reset = useCallback(() => {
    setState({
      searchQuery: '',
      currentPage: 1,
      sortColumn: null,
      sortDirection: 'asc',
    });
  }, []);

  return { state, setSearchQuery, setCurrentPage, toggleSort, reset };
}

export default function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  pageSize = 10,
  searchable = true,
  onRowClick,
  emptyMessage = 'No data available',
  loading = false,
}: DataTableProps<T>) {
  const { state, setSearchQuery, setCurrentPage, toggleSort, reset } =
    useFormState(pageSize);

  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());

  useEffect(() => {
    setSelectedRows(new Set());
  }, [data, state.searchQuery]);

  const filteredData = useMemo(() => {
    if (!state.searchQuery) return data;

    const query = state.searchQuery.toLowerCase();
    return data.filter((row) =>
      columns.some((col) => {
        const value = row[col.key];
        return value !== null && value !== undefined && String(value).toLowerCase().includes(query);
      })
    );
  }, [data, state.searchQuery, columns]);

  const sortedData = useMemo(() => {
    if (!state.sortColumn) return filteredData;

    return [...filteredData].sort((a, b) => {
      const valA = a[state.sortColumn!];
      const valB = b[state.sortColumn!];
      if (valA === valB) return 0;
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;

      const comparison = String(valA).localeCompare(String(valB));
      return state.sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [filteredData, state.sortColumn, state.sortDirection]);

  const totalPages = Math.ceil(sortedData.length / pageSize);
  const paginatedData = sortedData.slice(
    (state.currentPage - 1) * pageSize,
    state.currentPage * pageSize
  );

  const handleRowSelect = useCallback((index: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, row: T, index: number) => {
      if (event.key === 'Enter' && onRowClick) {
        onRowClick(row, index);
      }
    },
    [onRowClick]
  );

  if (loading) {
    return (
      <div className="data-table-loading" role="status" aria-label="Loading">
        <div className="spinner" />
        <span>Loading data...</span>
      </div>
    );
  }

  return (
    <div className="data-table-wrapper">
      {searchable && (
        <div className="data-table-toolbar">
          <input
            type="text"
            placeholder="Search..."
            value={state.searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="data-table-search"
            aria-label="Search table"
          />
          {state.searchQuery && (
            <button onClick={reset} className="data-table-clear" type="button">
              Clear
            </button>
          )}
          <span className="data-table-count">
            {filteredData.length} of {data.length} rows
          </span>
        </div>
      )}

      <table className="data-table" role="grid">
        <thead>
          <tr>
            <th className="select-col">
              <input type="checkbox" aria-label="Select all" />
            </th>
            {columns.map((col) => (
              <th
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                onClick={col.sortable ? () => toggleSort(col.key) : undefined}
                className={col.sortable ? 'sortable' : undefined}
                aria-sort={
                  state.sortColumn === col.key
                    ? state.sortDirection === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : undefined
                }
              >
                {col.label}
                {state.sortColumn === col.key && (
                  <span className="sort-indicator">
                    {state.sortDirection === 'asc' ? ' ▲' : ' ▼'}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paginatedData.length === 0 ? (
            <tr>
              <td colSpan={columns.length + 1} className="empty-row">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            paginatedData.map((row, idx) => {
              const globalIndex = (state.currentPage - 1) * pageSize + idx;
              return (
                <tr
                  key={globalIndex}
                  onClick={() => onRowClick?.(row, globalIndex)}
                  onKeyDown={(e) => handleKeyDown(e, row, globalIndex)}
                  className={selectedRows.has(globalIndex) ? 'selected' : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? 'button' : undefined}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedRows.has(globalIndex)}
                      onChange={() => handleRowSelect(globalIndex)}
                      aria-label={`Select row ${globalIndex + 1}`}
                    />
                  </td>
                  {columns.map((col) => (
                    <td key={col.key}>
                      {col.render ? col.render(row[col.key], row) : String(row[col.key] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="data-table-pagination">
          <button
            disabled={state.currentPage <= 1}
            onClick={() => setCurrentPage(state.currentPage - 1)}
            type="button"
          >
            Previous
          </button>
          <span>
            Page {state.currentPage} of {totalPages}
          </span>
          <button
            disabled={state.currentPage >= totalPages}
            onClick={() => setCurrentPage(state.currentPage + 1)}
            type="button"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
