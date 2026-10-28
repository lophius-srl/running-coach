#!/usr/bin/env bash
# Configure un repo GitHub pour le kit : labels, règles de merge, protection de main, board GitHub Projects.
# Usage : depuis la racine du repo (déjà poussé sur GitHub) :  ./scripts/setup-github.sh
# Prérequis : GitHub CLI (gh) connecté avec le scope "project" :  gh auth refresh -s project
set -euo pipefail

command -v gh >/dev/null || { echo "❌ GitHub CLI (gh) introuvable : https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "❌ Lance d'abord : gh auth login"; exit 1; }

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
OWNER=${REPO%%/*}
NAME=${REPO##*/}
VISIBILITY=$(gh repo view --json visibility -q .visibility)
echo "📦 Repo : $REPO ($VISIBILITY)"

# --- 1. CODEOWNERS -------------------------------------------------------------
if grep -q "@OWNER" .github/CODEOWNERS 2>/dev/null; then
  sed -i.bak "s/@OWNER/@$OWNER/g" .github/CODEOWNERS && rm -f .github/CODEOWNERS.bak
  echo "✅ CODEOWNERS → @$OWNER (pense à commiter ce changement)"
fi

# --- 2. Labels -----------------------------------------------------------------
echo "🏷️  Labels…"
label() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null; }
label "type: feature"     "1D76DB" "Nouvelle fonctionnalité"
label "type: bug"         "D73A4A" "Quelque chose ne marche pas"
label "type: chore"       "C5DEF5" "Technique, outillage, dépendances"
label "type: epic"        "5319E7" "Regroupe plusieurs issues"
label "type: docs"        "0075CA" "Documentation"
label "status: triage"    "FBCA04" "À clarifier ou découper"
label "status: ready"     "0E8A16" "Prête à être développée"
label "status: blocked"   "B60205" "Bloquée par autre chose"
label "priority: high"    "B60205" "Priorité haute"
label "priority: medium"  "FBCA04" "Priorité moyenne"
label "priority: low"     "C2E0C6" "Priorité basse"
label "size: XS"          "EDEDED" "Moins d'une heure"
label "size: S"           "D4D4D4" "Demi-journée"
label "size: M"           "BDBDBD" "1 à 2 jours"
label "size: L"           "9E9E9E" "Trop gros : à redécouper"
label "dependencies"      "0366D6" "Mise à jour de dépendances"
label "agent"             "F9D0C4" "Travail fait par un agent IA"
echo "✅ Labels créés"

# --- 3. Règles de merge ---------------------------------------------------------
# Squash uniquement, titre du commit = titre de la PR (commit conventionnel), branche supprimée après merge.
gh api -X PATCH "repos/$REPO" \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F delete_branch_on_merge=true -F allow_auto_merge=true >/dev/null
echo "✅ Merge : squash uniquement, branches supprimées après merge"

# Autorise GitHub Actions à ouvrir des PR (nécessaire pour release-please).
gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true >/dev/null
echo "✅ Actions : peut créer des PR (release-please)"

# --- 4. Protection de main (ruleset) -------------------------------------------
# Gratuit pour les repos publics. Pour un repo privé, il faut GitHub Pro (gratuit avec le GitHub Student Pack).
RULESET=$(cat <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [ { "context": "checks" } ] } }
  ]
}
JSON
)
if gh api "repos/$REPO/rulesets" -q '.[].name' 2>/dev/null | grep -qx "protect-main"; then
  echo "ℹ️  Ruleset protect-main déjà présent"
elif echo "$RULESET" | gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null 2>&1; then
  echo "✅ main protégée : PR obligatoire, CI verte obligatoire, conversations résolues"
else
  echo "⚠️  Impossible de protéger main (repo privé sur le plan gratuit ?)."
  echo "    → Passe le repo en public, ou utilise GitHub Pro, ou applique la règle à la main (voir GUIDE.md)."
fi

# --- 5. Board GitHub Projects ---------------------------------------------------
if [[ "${SKIP_PROJECT:-}" != "1" ]]; then
  echo "📋 Board GitHub Projects…"
  if PROJECT_NUMBER=$(gh project create --owner "$OWNER" --title "$NAME" --format json -q .number 2>/dev/null); then
    gh project link "$PROJECT_NUMBER" --owner "$OWNER" --repo "$REPO" >/dev/null
    gh project field-create "$PROJECT_NUMBER" --owner "$OWNER" --name "Priority" \
      --data-type SINGLE_SELECT --single-select-options "High,Medium,Low" >/dev/null
    gh project field-create "$PROJECT_NUMBER" --owner "$OWNER" --name "Size" \
      --data-type SINGLE_SELECT --single-select-options "XS,S,M,L" >/dev/null
    gh project field-create "$PROJECT_NUMBER" --owner "$OWNER" --name "Sprint" --data-type ITERATION >/dev/null 2>&1 \
      || echo "ℹ️  Champ Sprint (itération) : à ajouter dans l'interface web"
    echo "✅ Board créé et lié : https://github.com/users/$OWNER/projects/$PROJECT_NUMBER"
    echo "   → Termine la config dans l'interface (colonnes et automatisations) : voir GUIDE.md, étape 5."
  else
    echo "⚠️  Création du board impossible. Lance : gh auth refresh -s project   puis relance le script."
  fi
fi

echo
echo "🎉 Terminé. Reste à faire (voir GUIDE.md) :"
echo "   1. Dans Claude Code, lance /install-github-app (ou ajoute le secret CLAUDE_CODE_OAUTH_TOKEN)."
echo "   2. Settings → Code security : active Dependabot alerts et CodeQL."
echo "   3. Commite et pousse le CODEOWNERS mis à jour (via une PR !)."
