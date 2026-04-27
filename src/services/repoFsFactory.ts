import { ManifestProject } from "../models/manifestProject";
import { BundleCodeService } from "./bundleCodeService";
import { EditableCodeService } from "./editableCodeService";
import { RepoEditService } from "./repoEditService";
import { RepoExtractorService } from "./repoExtractorService";
import { DirEntry } from "./codeService";

export interface RepoFs {
    listDir(dirPath: string): Promise<DirEntry[]>;
    readFile(filepath: string): Promise<string>;
}

/**
 * Returns the right read API for a manifest repo:
 *   - EditableCodeService if the slug is in editable_repos
 *   - BundleCodeService (Cache, archive mode) otherwise
 */
export async function getRepoFs(
    project: ManifestProject,
    extractor: RepoExtractorService,
    editor: RepoEditService,
): Promise<RepoFs> {
    if (await editor.isEditable(project.slug)) {
        return new EditableCodeService(project.slug);
    }
    const svc = new BundleCodeService(
        "/ignored",
        {
            archiveUrl: `/${project.archive}`,
            indexUrl: `/${project.indexUrl}`,
            slug: project.slug,
        },
        extractor,
    );
    await svc.initialize();
    return svc;
}
