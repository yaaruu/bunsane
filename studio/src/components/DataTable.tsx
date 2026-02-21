import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  flexRender,
  type SortingState,
} from '@tanstack/react-table'
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface DataTableProps<T> {
    data: T[];
    columns: ColumnDef<T>[];
    loading: boolean;
    hasMore: boolean;
    sorting: SortingState;
    onSortingChange: (
        updater: SortingState | ((old: SortingState) => SortingState)
    ) => void;
    selectedRecords: Set<string>;
    onSelectionChange: (selected: Set<string>) => void;
    getRecordId: (record: T) => string;
    loadMoreRef: (node?: Element | null) => void;
    emptyMessage?: string;
    loadingMessage?: string;
    getRowClassName?: (record: T) => string;
}

export function DataTable<T extends Record<string, any>>({
    data,
    columns,
    loading,
    hasMore,
    sorting,
    onSortingChange,
    selectedRecords,
    onSelectionChange,
    getRecordId,
    loadMoreRef,
    emptyMessage = "No records found",
    loadingMessage = "Loading more records...",
    getRowClassName,
}: DataTableProps<T>) {
    const table = useReactTable({
        data,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        onSortingChange,
        state: {
            sorting,
            rowSelection: Object.fromEntries(
                Array.from(selectedRecords).map((id) => [
                    data.findIndex((d) => getRecordId(d) === id),
                    true,
                ])
            ),
        },
        onRowSelectionChange: (updater) => {
            const currentSelection = Object.fromEntries(
                Array.from(selectedRecords).map((id) => [
                    data.findIndex((d) => getRecordId(d) === id),
                    true,
                ])
            );
            const newSelection =
                typeof updater === "function"
                    ? updater(currentSelection)
                    : updater;
            const newSelectedRecords = new Set<string>();
            Object.entries(newSelection).forEach(([index, selected]) => {
                if (selected) {
                    const record = data[parseInt(index)];
                    if (record) {
                        newSelectedRecords.add(getRecordId(record));
                    }
                }
            });
            onSelectionChange(newSelectedRecords);
        },
    });

    const handleCellClick = (cell: any, event: React.MouseEvent) => {
        // Skip copy for select column
        if (cell.column.id === "select") return;

        // Prevent event bubbling
        event.stopPropagation();

        const value = cell.getValue();
        let textToCopy = "";

        // Extract the actual value if it has a .value property
        let actualValue = value;
        if (typeof value === "object" && value !== null && "value" in value) {
            actualValue = value.value;
        }

        // Only copy primitive values (not objects)
        if (typeof actualValue === "object" && actualValue !== null) {
            return; // Don't copy objects, let ReactJson handle it
        } else {
            textToCopy = String(actualValue ?? "");
        }

        if (textToCopy) {
            navigator.clipboard
                .writeText(textToCopy)
                .then(() => {
                    toast.success("Copied to clipboard", {
                        position: "top-center",
                    });
                })
                .catch(() => {
                    toast.error("Failed to copy", { position: "top-center" });
                });
        }
    };

    return (
        <div className="bg-card rounded-lg border border-border overflow-hidden">
            <div className="overflow-x-auto">
                <table className="w-full">
                    <thead className="bg-muted/50">
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr key={headerGroup.id}>
                                {headerGroup.headers.map((header) => (
                                    <th
                                        key={header.id}
                                        className="px-4 py-3 text-left text-sm font-medium text-muted-foreground border-b border-border"
                                    >
                                        {header.isPlaceholder ? null : (
                                            <div
                                                className={
                                                    header.column.getCanSort()
                                                        ? "cursor-pointer select-none flex items-center gap-2"
                                                        : ""
                                                }
                                                onClick={header.column.getToggleSortingHandler()}
                                            >
                                                {flexRender(
                                                    header.column.columnDef
                                                        .header,
                                                    header.getContext()
                                                )}
                                                {{
                                                    asc: "↑",
                                                    desc: "↓",
                                                }[
                                                    header.column.getIsSorted() as string
                                                ] ?? null}
                                            </div>
                                        )}
                                    </th>
                                ))}
                            </tr>
                        ))}
                    </thead>
                    <tbody>
                        {table.getRowModel().rows.map((row) => {
                            const extraClass = getRowClassName ? getRowClassName(row.original) : '';
                            return (
                            <tr
                                key={row.id}
                                className={`border-b border-border hover:bg-muted/50 ${extraClass}`}
                            >
                                {row.getVisibleCells().map((cell) => (
                                    <td
                                        key={cell.id}
                                        className="px-4 py-3 text-sm cursor-pointer hover:bg-muted/30"
                                        onClick={(e) =>
                                            handleCellClick(cell, e)
                                        }
                                    >
                                        {flexRender(
                                            cell.column.columnDef.cell,
                                            cell.getContext()
                                        )}
                                    </td>
                                ))}
                            </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {(loading || hasMore) && (
                <div ref={loadMoreRef} className="p-4 text-center">
                    {loading ? (
                        <div className="flex items-center justify-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {loadingMessage}
                        </div>
                    ) : (
                        <div className="text-muted-foreground">
                            Scroll for more
                        </div>
                    )}
                </div>
            )}

            {!loading && data.length === 0 && (
                <div className="p-8 text-center text-muted-foreground">
                    {emptyMessage}
                </div>
            )}
        </div>
    );
}
