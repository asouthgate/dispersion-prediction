#include <math.h>
#include <stdlib.h>
#include <string.h>

static const float LOG10 = 2.302585092994046f;

typedef struct {
    int ri, cj;
    float z;
} Lamp;

static int _cmp_lamps(const void* a, const void* b) {
    const Lamp* la = (const Lamp*)a;
    const Lamp* lb = (const Lamp*)b;
    if (la->ri != lb->ri) return la->ri - lb->ri;
    return la->cj - lb->cj;
}

static void _raycast(float* irr, int m, int n,
                      int ri_lamp, int cj_lamp, float z,
                      const float* soft, const float* hard, const float* terr,
                      float absorb, float pixw, int cutoff, float sensor_ht) {

    if (ri_lamp < 0 || ri_lamp >= m || cj_lamp < 0 || cj_lamp >= n) return;

    int px_cutoff = (int)ceilf((float)cutoff / pixw);
    int minj = cj_lamp - px_cutoff; if (minj < 0) minj = 0;
    int maxj = cj_lamp + px_cutoff; if (maxj > n) maxj = n;
    int mini = ri_lamp - px_cutoff; if (mini < 0) mini = 0;
    int maxi = ri_lamp + px_cutoff; if (maxi > m) maxi = m;

    float lamp_elev = terr[ri_lamp * n + cj_lamp] + z;

    for (int cj = minj; cj < maxj; ++cj) {
        float pxdist_base = (float)(cj_lamp - cj);
        float pxdist2 = pxdist_base * pxdist_base;

        for (int ri = mini; ri < maxi; ++ri) {
            float pydist_base = (float)(ri_lamp - ri);
            float pxydist = sqrtf(pxdist2 + pydist_base * pydist_base);
            int pdist = (int)floorf(pxydist + 0.5f);

            float zdist = lamp_elev - (terr[ri * n + cj] + sensor_ht);
            float xydist = pxydist * pixw;
            float xyzdist2 = xydist * xydist + zdist * zdist;

            if (xydist >= (float)cutoff || zdist <= 0 || pdist <= 0) continue;

            float shadow = 1.0f;
            float shading = 0.0f;

            float step_i = pydist_base / (float)pdist;
            float step_j = pxdist_base / (float)pdist;
            float step_h = zdist / (float)pdist;
            float cell_elev = terr[ri * n + cj] + sensor_ht;

            for (int d = 1; d <= pdist; ++d) {
                float frac = (float)d;
                int dii = (int)roundf((float)ri + step_i * frac);
                int djj = (int)roundf((float)cj + step_j * frac);
                float hiijj = cell_elev + step_h * frac;

                if (hard[dii * n + djj] + terr[dii * n + djj] >= hiijj) {
                    shadow = 0.0f;
                    break;
                }
                if (soft[dii * n + djj] + terr[dii * n + djj] >= hiijj) {
                    shading += pixw * sqrtf(xyzdist2) / xydist;
                }
            }

            float invd = 1.0f / xyzdist2;
            float occ = 1.0f / expf(absorb * shading * LOG10);
            irr[ri * n + cj] += occ * shadow * invd;
        }
    }
}

void irradiance_run(const float* lamps, int nlamps,
                    const float* soft, const float* hard, const float* terr,
                    float* output, int m, int n,
                    float pixw, int cutoff, float sensor_ht, float absorb) {

    Lamp* parsed = (Lamp*)malloc((size_t)nlamps * sizeof(Lamp));
    for (int i = 0; i < nlamps; ++i) {
        parsed[i].cj = (int)roundf(lamps[i * 3 + 0]);
        parsed[i].ri = (int)roundf(lamps[i * 3 + 1]);
        parsed[i].z = lamps[i * 3 + 2];
    }
    qsort(parsed, (size_t)nlamps, sizeof(Lamp), _cmp_lamps);

    for (int i = 0; i < nlamps; ++i) {
        _raycast(output, m, n, parsed[i].ri, parsed[i].cj, parsed[i].z,
                 soft, hard, terr, absorb, pixw, cutoff, sensor_ht);
    }
    free(parsed);
}

void irradiance_to_resistance(float* io_raster, int m, int n,
                              float resmax, float xmax) {
    int total = m * n;
    float maxpi = 0.0f;
    for (int i = 0; i < total; ++i) {
        if (io_raster[i] > maxpi) maxpi = io_raster[i];
    }
    if (maxpi <= 0.0f) return;
    for (int i = 0; i < total; ++i) {
        io_raster[i] = powf(io_raster[i] / maxpi, xmax) * resmax;
    }
}

void irradiance_combine(float* total, const float* lamp,
                        const float* road, const float* river,
                        const float* landscape, const float* linear,
                        const float* generic, int m, int n) {
    int sz = m * n;
    float tmin = INFINITY;
    float tmax = -INFINITY;

    for (int i = 0; i < sz; ++i) {
        float v = lamp[i] + road[i] + river[i] + landscape[i]
                + linear[i] + generic[i] + 1.0f;
        total[i] = v;
        if (v < tmin) tmin = v;
        if (v > tmax) tmax = v;
    }

    float range = tmax - tmin;
    if (range <= 0.0f) return;
    for (int i = 0; i < sz; ++i) {
        total[i] = ((total[i] - tmin) * 9999.0f) / range + 1.0f;
    }
}
