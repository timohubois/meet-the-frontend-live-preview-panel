<?php

namespace MeetTheFrontendLivePreviewPanel;

/** Run the shipped timestamped migrations in the context of the current site. */
final class Migrations
{
    public function __construct()
    {
        add_action('admin_init', [self::class, 'runForSite']);
    }

    public static function runForSite(): void
    {
        if (wp_doing_ajax() || !current_user_can('manage_options')) {
            return;
        }
        foreach (self::classes() as $migration) {
            $migration::runForSite();
        }
    }

    /** @return list<string> Retired panel preference scopes to remove during uninstall. */
    public static function uninstallForSite(): array
    {
        $scopes = [];
        foreach (self::classes() as $migration) {
            $scopes = array_merge($scopes, $migration::uninstallForSite());
        }
        return $scopes;
    }

    /** @return list<class-string> */
    private static function classes(): array
    {
        static $classes = null;
        if ($classes !== null) {
            return $classes;
        }

        $classes = [];
        $directory = __DIR__ . '/Migrations';
        if (!is_dir($directory)) {
            return $classes;
        }

        // Treat the installation path literally, even when it contains glob metacharacters.
        $files = scandir($directory, SCANDIR_SORT_NONE) ?: [];
        sort($files, SORT_NATURAL);
        foreach ($files as $file) {
            $path = $directory . '/' . $file;
            if (!preg_match('/^([0-9]+)\.php$/D', $file, $match) || !is_file($path)) {
                continue;
            }
            require_once $path;
            $classes[] = __NAMESPACE__ . '\\Migrations\\Migration' . $match[1];
        }
        return $classes;
    }
}
