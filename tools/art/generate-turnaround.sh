#!/usr/bin/env bash
# Step 1 of the character pipeline: one image holding all 8 facings.
#
#   tools/art/generate-turnaround.sh <outDir> <desc-file> <biped|quadruped> [refImage]
#
# One image is the point. An image model holds a character together inside a
# single picture and drifts between separate ones, so the 8 angles are drawn
# together and every later step refers back to them.
#
# See tools/art/README.md.
set -euo pipefail

OUT="$1"; DESCFILE="$2"; KIND="$3"; REF="${4:-}"
mkdir -p "$OUT"

if [ "$KIND" = "biped" ]; then
  STANCE="standing at rest, upright, with both feet on the ground"
  ORDER=$'1. Facing the viewer (front)\n2. Facing the viewer and to the lower-right of the picture\n3. Facing directly to the picture'"'"$'s right, a full side view\n4. Facing away and to the upper-right, a back three-quarter view\n5. Facing directly away from the viewer (back)\n6. Facing away and to the upper-left, a back three-quarter view\n7. Facing directly to the picture'"'"$'s left, a full side view\n8. Facing the viewer and to the lower-left of the picture'
else
  STANCE="standing at rest on all four legs, with its paws on the ground"
  ORDER=$'1. Facing the viewer, head on, coming toward the camera\n2. Facing the viewer and to the lower-right of the picture, a front three-quarter view\n3. Facing directly to the picture'"'"$'s right, a full side view\n4. Facing away and to the upper-right, a rear three-quarter view\n5. Facing directly away from the viewer, tail toward the camera\n6. Facing away and to the upper-left, a rear three-quarter view\n7. Facing directly to the picture'"'"$'s left, a full side view\n8. Facing the viewer and to the lower-left of the picture, a front three-quarter view'
fi

cat > "$OUT/prompt-turnaround.txt" <<EOF
Use the \$imagegen skill.

Draw $(cat "$DESCFILE"). Keep it dark-fantasy pixel art with a muted, desaturated palette and chunky low-resolution fidelity.

Generate ONE image: a TURNAROUND of that SAME character $STANCE, in 8 different facing directions, laid out as 2 rows of 4 cells.

Reading order, left to right, top row then bottom row:
$ORDER

- All 8 figures are the SAME height and the SAME scale, and hold the SAME posture and the SAME body proportions. Only the facing changes.
- The camera is slightly above, a gentle top-down three-quarter angle, the same in every cell.
- Draw each angle honestly. Do not mirror a cell. The head-on and rear views must be genuine foreshortened views, not side views.
- If the character carries anything, it stays in the same hand in all 8 cells. Never swap it over.
- Even margins, evenly spaced cells, no frame borders, no grid lines, no text, no numbers, no ground shadows.
- Flat pure magenta (#FF00FF) background, completely uniform.

Chroma-key it out with the helper and save the transparent result as $OUT/turnaround.png. Report the path.
EOF

cd "$OUT"
if [ -n "$REF" ]; then
  codex exec -s workspace-write --skip-git-repo-check -C . -i "$REF" - < "$OUT/prompt-turnaround.txt"
else
  codex exec -s workspace-write --skip-git-repo-check -C . - < "$OUT/prompt-turnaround.txt"
fi
echo "turnaround -> $OUT/turnaround.png"
