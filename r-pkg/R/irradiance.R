library(Rcpp)
library(logger)
sourceCpp("r-pkg/R/irradiance.cpp")

wrap_cal_irradiance <- function(lampdf, soft, hard, terr, absorbance=0.5, pixw=1, cutoff=100, sensor_ht=0) {

    logger::log_info("Calculating point irradiance.")

    xmin <- hard@extent@xmin
    xmax <- hard@extent@xmax
    ymin <- hard@extent@ymin
    ymax <- hard@extent@ymax

    hard[is.na(hard[])] <- 0
    soft[is.na(soft[])] <- 0
    terr[is.na(terr[])] <- 0

    vals <- unname(as.matrix(lampdf))
    # print("matrix vals")
    # print(vals)
    # print(typeof(lampdf))
    # print(typeof(vals))
    # print(class(vals))
    
    # print(xmin)
    # print(xmax)
    # print(ymin)
    # print(ymax)
    # print(absorbance)
    # print(pixw)
    # print(cutoff)
    # print(sensor_ht)

    irrcpp <- cal_irradiance(vals, 
                            as.matrix(soft), as.matrix(hard), as.matrix(terr),
                            xmin, xmax, ymin, ymax,
                            absorbance, pixw, cutoff, sensor_ht)

    irast <- soft
    irast[] <- irrcpp
    return(irast)
}