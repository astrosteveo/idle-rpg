#!/usr/bin/env bash
# Step 3 of the character pipeline: the frames for one facing.
#
#   tools/art/generate-strips.sh <workDir> <desc-file> <biped|quadruped> <DIR...>
#
# `workDir` must already hold ref-<DIR>.png from cut-turnaround.mjs. Each
# reference pins both the character and the camera angle, so the model only has
# to animate, not invent.
#
# Name several directions to run them in turn, or start one process for each to
# run them at once.
#
# See tools/art/README.md.
set -euo pipefail

WORK="$1"; DESCFILE="$2"; KIND="$3"; shift 3

declare -A ANGLE=(
  [S]="facing the viewer, coming toward the camera"
  [SE]="facing the viewer and toward the lower-right of the picture, a front three-quarter view"
  [E]="facing directly to the picture's right, a full side view"
  [NE]="facing away from the viewer and toward the upper-right, a back three-quarter view"
  [N]="facing directly away from the viewer, seen from behind"
  [NW]="facing away from the viewer and toward the upper-left, a back three-quarter view"
  [W]="facing directly to the picture's left, a full side view"
  [SW]="facing the viewer and toward the lower-left of the picture, a front three-quarter view"
)

# Naming the mechanics of each frame is what stops the model drawing four
# near-identical standing poses. Saying "a walk cycle" is not enough.
if [ "$KIND" = "biped" ]; then
COUNT=7
read -r -d '' GAIT <<'G' || true
Frames 1 to 4 are a WALK CYCLE. The legs must change a LOT between frames. A viewer flicking between them must see the feet swap immediately. Do not draw four near-identical standing poses.
- Frame 1, CONTACT: the LEFT foot is forward and flat on the ground, the RIGHT foot is back with the heel lifted. The legs are wide apart in a full stride.
- Frame 2, PASSING: the RIGHT knee is bent and the RIGHT foot is lifted clear of the ground beside the left ankle. The LEFT leg is straight and carries all the weight. The body rides slightly higher.
- Frame 3, CONTACT: the exact opposite of frame 1. The RIGHT foot is forward and flat, the LEFT foot is back with the heel lifted, legs wide apart.
- Frame 4, PASSING: the exact opposite of frame 2. The LEFT knee is bent and the LEFT foot is lifted clear of the ground. The RIGHT leg is straight and carries the weight.
The arms swing in opposition to the legs.
IMPORTANT FOR HEAD-ON AND REAR ANGLES: if this angle looks at the figure from the front or from behind, the leg swing is easy to lose. Exaggerate it. In the CONTACT frames the two boots must be clearly separated, the forward one drawn lower on the picture and larger because it is nearer the camera. In the PASSING frames the lifted boot must be unmistakably off the ground with a gap of clear background beneath its sole, and the whole body sits a little higher.
Frames 5 to 7 are a WEAPON SWING: 5 is the wind-up drawn back, 6 is mid-swing, 7 is the follow-through.
G
else
COUNT=6
read -r -d '' GAIT <<'G' || true
Frames 1 to 4 are a WALK CYCLE. The legs must change a LOT between frames. A viewer flicking between them must see the paws swap immediately. Do not draw four near-identical standing poses.
- Frame 1, CONTACT: the FRONT-LEFT and REAR-RIGHT legs are forward and planted; the FRONT-RIGHT and REAR-LEFT legs are stretched back. The legs are far apart in a full stride.
- Frame 2, PASSING: the FRONT-RIGHT and REAR-LEFT legs swing forward under the body with the paws lifted clear of the ground and the joints bent.
- Frame 3, CONTACT: the exact opposite of frame 1. The FRONT-RIGHT and REAR-LEFT legs are forward and planted, the others stretched back.
- Frame 4, PASSING: the exact opposite of frame 2. The FRONT-LEFT and REAR-RIGHT legs swing forward, paws lifted clear of the ground.
IMPORTANT FOR HEAD-ON AND REAR ANGLES: if this angle looks at the animal from the front or from behind, the leg swing is easy to lose. Exaggerate it. In the CONTACT frames the forward paws must be clearly separated from the rear ones and drawn lower on the picture. In the PASSING frames the lifted paws must be unmistakably off the ground with a gap of clear background beneath them.
Frame 5 is a WIND-UP: head low, weight shifted back on the haunches, about to spring.
Frame 6 is the ATTACK: lunging forward, jaws open.
G
fi

for D in "$@"; do
  cat > "$WORK/prompt-$D.txt" <<EOF
Use the \$imagegen skill.

The attached image is the EXACT character and the EXACT camera angle you must draw. It is $(cat "$DESCFILE"), ${ANGLE[$D]}. Reproduce it precisely: same colours, same markings, same gear, same muted palette, same chunky pixel-art fidelity, same proportions, same size, same camera angle, same body posture and body length.

Generate ONE sprite strip PNG of that SAME character at that SAME angle. It must contain EXACTLY $COUNT figures in a single horizontal row, evenly spaced, frame 1 at the far left. Count them before you finish.

$GAIT

- Every frame keeps the SAME facing direction as the attached image, the SAME overall size, and stands on the SAME ground line.
- If the character carries anything, it stays in the same hand in every frame. Never swap it over and never mirror the figure.
- Even margins between frames. No frame borders, no grid lines, no text, no numbers, no ground shadows.
- Flat pure magenta (#FF00FF) background, completely uniform.

Chroma-key it out with the helper and save the transparent result as $WORK/strip-$D.png. Report the path.
EOF
  (cd "$WORK" && codex exec -s workspace-write --skip-git-repo-check -C . -i "$WORK/ref-$D.png" - < "$WORK/prompt-$D.txt" > "$WORK/log-$D.txt" 2>&1)
  echo "strip $D -> $WORK/strip-$D.png"
done
