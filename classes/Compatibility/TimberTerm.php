<?php

namespace AFloatingLivePreviewPanel\Compatibility;

use WP_Term;

/** Import the matching archive's preview fields without changing the term Timber was given. */
final class TimberTerm extends \Timber\Term
{
    private static ?WP_Term $preview = null;
    private static ?WP_Term $saved = null;
    private bool $routing = false;

    public static function setPreview(?WP_Term $term, ?WP_Term $saved = null): void
    {
        self::$preview = $term ? clone $term : null;
        self::$saved = $saved ? clone $saved : null;
    }

    private static function matches(WP_Term $term): bool
    {
        return self::$preview && $term->term_taxonomy_id === self::$preview->term_taxonomy_id;
    }

    public static function previewClass(string $class, WP_Term $term): string
    {
        // Do not replace custom term classes chosen by the theme.
        return $class === \Timber\Term::class && self::matches($term) ? self::class : $class;
    }

    protected function init(WP_Term $term)
    {
        if (self::matches($term)) {
            $term = clone $term;
            $term->name = self::$preview->name;
            $term->description = self::$preview->description;
        }
        parent::init($term);
        if (self::matches($term) && self::$saved) {
            // Timber uses its backing WP_Term for WordPress permalink filters.
            $this->wp_object = clone self::$saved;
        }
    }

    public function link()
    {
        $saved = $this->wp_object();
        if ($this->routing || !$saved) {
            return parent::link();
        }
        // Timber's own link filters receive a Timber object, not just the backing WP_Term.
        $routing = clone $this;
        $routing->routing = true;
        $routing->name = $saved->name;
        $routing->description = $saved->description;
        return $routing->link();
    }

    public function description()
    {
        $saved = $this->wp_object();
        if (!$this->routing || !$saved) {
            return parent::description();
        }
        // Only the routing copy reads the saved description. Restore it after the preview
        // substitution, before WordPress and Timber apply their usual formatting.
        $restore = static function ($value, $id, $taxonomy) use ($saved) {
            static $restored = false;
            if (!$restored && (int) $id === $saved->term_id && $taxonomy === $saved->taxonomy) {
                $restored = true;
                return $saved->description;
            }
            return $value;
        };
        add_filter('term_description', $restore, PHP_INT_MIN, 3);
        try {
            return parent::description();
        } finally {
            remove_filter('term_description', $restore, PHP_INT_MIN);
        }
    }
}
