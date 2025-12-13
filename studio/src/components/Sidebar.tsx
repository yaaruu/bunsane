import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
    Database,
    Home,
    ChevronDown,
    ChevronRight,
    PanelLeftOpenIcon,
    PanelLeftCloseIcon,
    FlameIcon,
} from "lucide-react";
import { useStudioStore } from "../store/studio";
import { fetchTables } from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

declare global {
    interface Window {
        bunsaneMetadata?: {
            archeTypes: Record<
                string,
                {
                    fieldName: string;
                    componentName: string;
                    fieldLabel: string;
                }[]
            >;
        };
    }
}

type SidebarSection = {
    id: string;
    title: string;
    icon: typeof Database;
    items: string[];
    getRoutePath: (item: string) => string;
};

export function Sidebar() {
    const location = useLocation();
    const {
        metadata,
        tables,
        setMetadata,
        setTables,
        setLoading,
        setError,
        isSidebarCollapsed,
        expandedSections,
        setSidebarCollapsed,
        toggleSection,
    } = useStudioStore();

    useEffect(() => {
        // Load metadata from window
        if (window.bunsaneMetadata) {
            setMetadata(window.bunsaneMetadata);
        }

        // Load tables
        const loadTables = async () => {
            try {
                setLoading(true);
                const tablesData = await fetchTables();
                setTables(tablesData);
            } catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : "Failed to load tables"
                );
            } finally {
                setLoading(false);
            }
        };

        loadTables();
    }, [setMetadata, setTables, setLoading, setError]);

    const archeTypeNames = metadata ? Object.keys(metadata.archeTypes) : [];

    const sections: SidebarSection[] = [
        {
            id: "archeTypes",
            title: "ArcheTypes",
            icon: FlameIcon,
            items: archeTypeNames,
            getRoutePath: (archeTypeName) => `/archetype/${archeTypeName}`,
        },
        {
            id: "tables",
            title: "Tables",
            icon: Database,
            items: tables,
            getRoutePath: (tableName) => `/table/${tableName}`,
        },
    ];

    const handleToggleSection = (section: string) => {
        if (isSidebarCollapsed) {
            setSidebarCollapsed(false);
            if (!expandedSections[section]) {
                toggleSection(section);
            }
            return;
        }

        toggleSection(section);
    };

    const handleToggleSidebar = () => {
        setSidebarCollapsed(!isSidebarCollapsed);
    };

    return (
        <aside
            className={cn(
                "bg-card border-r border-border flex flex-col transition-all duration-300",
                isSidebarCollapsed ? "w-16" : "w-80"
            )}
        >
            <div
                className={cn(
                    "p-6 border-b border-border flex items-center justify-between",
                    isSidebarCollapsed && "p-4"
                )}
            >
                {!isSidebarCollapsed && (
                    <div>
                        <h1 className="text-2xl font-bold text-primary">
                            BunSane Studio
                        </h1>
                        <p className="text-sm text-muted-foreground mt-1">
                            Database Management
                        </p>
                    </div>
                )}
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleToggleSidebar}
                    className={cn(
                        "text-muted-foreground hover:text-foreground",
                        isSidebarCollapsed && "mx-auto"
                    )}
                >
                    {isSidebarCollapsed ? (
                        <PanelLeftOpenIcon className="h-5 w-5" />
                    ) : (
                        <PanelLeftCloseIcon className="h-5 w-5" />
                    )}
                </Button>
            </div>

            <nav className="flex-1 overflow-auto p-4">
                <div className="space-y-2">
                    {/* Welcome */}
                    <Link
                        to="/"
                        className={cn(
                            "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                            location.pathname === "/"
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                            isSidebarCollapsed && "justify-center px-0"
                        )}
                        title={isSidebarCollapsed ? "Welcome" : undefined}
                    >
                        <Home className="h-4 w-4" />
                        {!isSidebarCollapsed && "Welcome"}
                    </Link>

                    {/* Dynamic Sections */}
                    {sections.map((section) => {
                        const Icon = section.icon;
                        const isExpanded = expandedSections[section.id];

                        return (
                            <div key={section.id} className="space-y-1">
                                <button
                                    onClick={() =>
                                        handleToggleSection(section.id)
                                    }
                                    className={cn(
                                        "w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground rounded-md transition-colors",
                                        isSidebarCollapsed &&
                                            "justify-center px-0"
                                    )}
                                    title={
                                        isSidebarCollapsed
                                            ? `${section.title} (${section.items.length})`
                                            : undefined
                                    }
                                >
                                    <Icon className="h-4 w-4" />
                                    {!isSidebarCollapsed && (
                                        <>
                                            <span className="flex-1 text-left">
                                                {section.title} (
                                                {section.items.length})
                                            </span>
                                            {isExpanded ? (
                                                <ChevronDown className="h-4 w-4" />
                                            ) : (
                                                <ChevronRight className="h-4 w-4" />
                                            )}
                                        </>
                                    )}
                                </button>
                                {!isSidebarCollapsed && isExpanded && (
                                    <div className="ml-4 space-y-1">
                                        {section.items.map((item) => {
                                            const routePath =
                                                section.getRoutePath(item);

                                            return (
                                                <Link
                                                    key={item}
                                                    to={routePath}
                                                    className={cn(
                                                        "block px-3 py-2 rounded-md text-sm transition-colors",
                                                        location.pathname ===
                                                            routePath
                                                            ? "bg-primary text-primary-foreground"
                                                            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                                                    )}
                                                >
                                                    {item}
                                                </Link>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </nav>
        </aside>
    );
}
