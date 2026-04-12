export interface Tag {
    id: string;
    name: string;
    color: string;      // hex color e.g. "#6b7280"
    parentId?: string;  // undefined = root tag
}
